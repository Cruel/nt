import {
  analyzeAuthoringSources,
  collectAuthoringLuaSources,
  collectAuthoringSourceRequirements,
  type AuthoringLuaSourceDescriptor,
} from '../authoring-source-analysis';
import { projectWorkspaceLocalStateFile } from '../editor-local-state-file';
import { z } from 'zod';
import { nativeOperation } from '../project-schema/native-schema-operations';
import {
  yamlCommentImpacts,
  yamlCommentTokenMentions,
  annotatedYamlPaths,
  removeChangedYamlComments,
  type YamlCommentImpact,
} from './yaml-comment-impact';
import { restoreMissingYamlSource } from './yaml-source-restoration';
import { remapYamlRecordMetadata } from './structured-yaml-source';
import {
  localizationMessageSourceViews,
  updateLocalizationMessageSourceViews,
} from '../authoring-localization-workflow';
import { workspaceManifestSchema } from './workspace-manifest-schema';
import {
  compareProjectWorkspaceUnicodeCodePoints,
  projectWorkspaceSourceCodec,
  type CanonicalSourceSchema,
} from './project-workspace-source-codec';
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
import {
  classifyWorkspaceEditEffects,
  externalAssetContributionKeys,
  type WorkspaceEditEffects,
} from './workspace-edit-effects';
import {
  authoringProjectSchema,
  cloneAuthoringProject,
  type AuthoringProject,
} from '../project-schema/authoring-project';
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
} from '../project-schema/project-diagnostic-projection';
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
export { compareProjectWorkspaceUnicodeCodePoints } from './project-workspace-source-codec';

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

const traitsWorkspaceSchema = nativeOperation(
  'workspace.trait-key',
  z.record(entityIdSchema, traitDefinitionSchema).superRefine((traits, ctx) => {
    for (const [key, trait] of Object.entries(traits))
      if (trait.id !== key)
        ctx.addIssue({
          code: 'custom',
          path: [key, 'id'],
          message: `Trait id '${trait.id}' must match its map key '${key}'.`,
        });
  }),
);

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
        /** Original YAML document, including comment nodes. */
        sourceText?: string;
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
  /** Resident authority/reconciliation timing, included only during profiling. */
  readonly residentAdmissionMs?: Readonly<{
    firstAuthority: number;
    semanticReconciliation: number;
    proofAuthority: number;
  }>;
  readonly residentReconcileMs?: Readonly<{
    readAndProject: number;
    semanticChecks: number;
    revisionAndDiagnostics: number;
    snapshotIndexes: number;
  }>;
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
  /** Revision identity of the latest generation that changed localization/font-coverage inputs. */
  readonly localizationCoverageDependencyRevision: `sha256:${string}`;
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

const sortKeys = <T>(value: Record<string, T>) =>
  Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => compareProjectWorkspaceUnicodeCodePoints(a, b)),
  ) as Record<string, T>;

const canonicalJson = (value: unknown, schema?: CanonicalSourceSchema): string =>
  projectWorkspaceSourceCodec('machine.json').encode(value, schema);
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

export const projectWorkspaceSourceSchemas = {
  WorkspaceManifest: workspaceManifestSchema,
  WorkspaceTraitDeclarations: traitsWorkspaceSchema,
  WorkspaceTrackedEditor: trackedEditorOrganizationSchema,
  WorkspaceLocalEditor: editorLocalStateSchema,
  WorkspaceLocalizationPolicy: localizationPolicyFragmentSchema,
  WorkspaceLocalizationMessages: localizationMessagesFragmentSchema,
  WorkspaceLocalizationUsageNotes: localizationUsageNotesFragmentSchema,
  WorkspaceLocalizationTracking: localizationTrackingFragmentSchema,
  WorkspaceLocalizationOrphans: localizationOrphansFragmentSchema,
  WorkspaceLocalizationLocale: localizationTranslationSchema,
  WorkspaceLocalizationAssets: localizationAssetsLocaleFragmentSchema,
} as const;

/** Local source-schema admission for explicit fmt compaction; never resolves Project references. */
export function validateYamlCompactionSource(file: string, text: string): unknown {
  const value = projectWorkspaceSourceCodec(file).decode(text);
  if (file === 'project.yaml') return workspaceManifestSchema.parse(value);
  if (file === 'traits.yaml') return traitsWorkspaceSchema.parse(value);
  if (file === 'editor.yaml') return trackedEditorOrganizationSchema.parse(value);
  const fragments: Readonly<Record<string, z.ZodType>> = {
    'i18n/project.yaml': localizationPolicyFragmentSchema,
    'i18n/messages.yaml': localizationMessagesFragmentSchema,
    'i18n/usage-notes.yaml': localizationUsageNotesFragmentSchema,
    'i18n/tracking.yaml': localizationTrackingFragmentSchema,
    'i18n/orphans.yaml': localizationOrphansFragmentSchema,
  };
  if (fragments[file]) return fragments[file].parse(value);
  const locale = /^i18n\/(locales|assets)\/([^/]+)\.yaml$/u.exec(file);
  if (locale) {
    localeIdSchema.parse(locale[2]);
    const schema =
      locale[1] === 'locales'
        ? localizationTranslationSchema
        : localizationAssetsLocaleFragmentSchema;
    const parsed = schema.parse(value);
    if (Object.keys(parsed).length === 0)
      throw new Error('Empty localization chunk is not a valid tracked source.');
    return parsed;
  }
  return value;
}

const LOCALIZATION_POLICY_FILE = 'i18n/project.yaml';
const LOCALIZATION_MESSAGES_FILE = 'i18n/messages.yaml';
const LOCALIZATION_USAGE_NOTES_FILE = 'i18n/usage-notes.yaml';
const LOCALIZATION_TRACKING_FILE = 'i18n/tracking.yaml';
const LOCALIZATION_ORPHANS_FILE = 'i18n/orphans.yaml';
const localizationTranslationFile = (locale: string) => `i18n/locales/${locale}.yaml`;
const localizationAssetsFile = (locale: string) => `i18n/assets/${locale}.yaml`;

function projectWorkspaceLocalizationFile(
  localization: AuthoringLocalization,
  file: string,
  previousText?: string,
): string | undefined {
  const encode = (value: unknown, schema: CanonicalSourceSchema) =>
    projectWorkspaceSourceCodec(file).encode(value, schema, previousText);
  if (file === LOCALIZATION_POLICY_FILE)
    return encode(
      {
        sourceLocale: localization.sourceLocale,
        sourceLocaleLock:
          localization.sourceLocaleLock ??
          (hasSubstantiveLocalizationWork(localization) ? localization.sourceLocale : null),
        defaultLocale: localization.defaultLocale,
        locales: localization.locales,
      },
      localizationPolicyFragmentSchema,
    );
  if (file === LOCALIZATION_MESSAGES_FILE)
    return encode(
      {
        messages: localization.messages,
        structuredMessageIds: localization.structuredMessageIds,
      },
      localizationMessagesFragmentSchema,
    );
  if (file === LOCALIZATION_USAGE_NOTES_FILE)
    return encode(localization.usageNotes, localizationUsageNotesFragmentSchema);
  if (file === LOCALIZATION_TRACKING_FILE)
    return encode(localization.sourceMessageTracking, localizationTrackingFragmentSchema);
  if (file === LOCALIZATION_ORPHANS_FILE)
    return encode(localization.orphanedMessages, localizationOrphansFragmentSchema);
  const translation = /^i18n\/locales\/([^/]+)\.yaml$/u.exec(file);
  if (translation) {
    const translations = localization.translations[translation[1]!] ?? {};
    return Object.keys(translations).length > 0
      ? encode(translations, localizationTranslationSchema)
      : undefined;
  }
  const localizedAssets = /^i18n\/assets\/([^/]+)\.yaml$/u.exec(file);
  if (localizedAssets) {
    const assets = localization.assets[localizedAssets[1]!] ?? {};
    return Object.keys(assets).length > 0
      ? encode(assets, localizationAssetsLocaleFragmentSchema)
      : undefined;
  }
  return undefined;
}

function projectWorkspaceLocalizationPaths(localization: AuthoringLocalization): readonly string[] {
  return [
    LOCALIZATION_POLICY_FILE,
    LOCALIZATION_MESSAGES_FILE,
    LOCALIZATION_USAGE_NOTES_FILE,
    LOCALIZATION_TRACKING_FILE,
    LOCALIZATION_ORPHANS_FILE,
    ...Object.entries(localization.translations)
      .filter(([, translations]) => Object.keys(translations).length > 0)
      .map(([locale]) => localizationTranslationFile(locale)),
    ...Object.entries(localization.assets)
      .filter(([, assets]) => Object.keys(assets).length > 0)
      .map(([locale]) => localizationAssetsFile(locale)),
  ];
}

export function projectWorkspaceLocalizationFiles(
  localization: AuthoringLocalization,
): Readonly<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const file of projectWorkspaceLocalizationPaths(localization)) {
    const text = projectWorkspaceLocalizationFile(localization, file);
    if (text !== undefined) files[file] = text;
  }
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
const recordFile = (collection: AuthoringCollectionKey, id: string) => {
  const stem =
    collection === 'layouts' ? `records/layouts/${id}/layout` : `records/${collection}/${id}`;
  return `${stem}.yaml`;
};

export function sourceContributionOwnerPaths(
  file: string,
  scriptSourcePaths: Readonly<Record<string, string>>,
): readonly string[] {
  if (file === 'project.yaml')
    return [
      '/project',
      '/settings',
      '/export',
      '/bootstrapModule',
      '/entrypoint',
      '/inventories',
      '/interactableInstances',
    ];
  if (file === 'traits.yaml') return ['/traits'];
  if (file === 'editor.yaml') return ['/editor/chapters', '/editor/tags', '/editor/recordMetadata'];
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
  const localeMatch = file.match(/^i18n\/locales\/([^/]+)\.yaml$/u);
  if (localeMatch)
    return [`/localization/translations/${escapeJsonPointerSegment(localeMatch[1]!)}`];
  const localizedAssetMatch = file.match(/^i18n\/assets\/([^/]+)\.yaml$/u);
  if (localizedAssetMatch)
    return [`/localization/assets/${escapeJsonPointerSegment(localizedAssetMatch[1]!)}`];

  const layoutMatch = file.match(/^records\/layouts\/([^/]+)\/layout\.(yaml|rml|rcss|lua)$/u);
  if (layoutMatch) {
    const id = escapeJsonPointerSegment(layoutMatch[1]!);
    const channel = layoutMatch[2]!;
    return channel === 'yaml' ? [`/layouts/${id}`] : [`/layouts/${id}/data/${channel}`];
  }
  const recordMatch = file.match(/^records\/([^/]+)\/([^/]+)\.yaml$/u);
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
    const ids = id ? [id] : Object.keys(project[head]);
    const files = new Set<string>();
    for (const candidateId of ids) {
      files.add(recordFile(head, candidateId));
      if (head === 'layouts') {
        files.add(layoutFile(candidateId, 'rml'));
        files.add(layoutFile(candidateId, 'rcss'));
        files.add(layoutFile(candidateId, 'lua'));
      } else if (head === 'scripts') {
        const candidate = project.scripts[candidateId];
        if (candidate?.data.source.kind === 'inline-lua')
          files.add(scriptSourcePaths[candidateId] ?? `scripts/${candidateId}.lua`);
      }
    }
    return [...files];
  }
  if (head === 'editor') return ['editor.yaml'];
  if (head === 'localization')
    return Object.keys(projectWorkspaceLocalizationFiles(project.localization));
  if (head === 'traits') return ['traits.yaml'];
  if (
    head === 'project' ||
    head === 'settings' ||
    head === 'export' ||
    head === 'bootstrapModule' ||
    head === 'entrypoint' ||
    head === 'inventories' ||
    head === 'interactableInstances'
  )
    return ['project.yaml'];
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
    candidateFiles.forEach((file) => {
      const layout = /^records\/layouts\/([^/]+)\/layout\.yaml$/u.exec(file);
      if (layout) {
        files.add(recordFile('layouts', layout[1]!));
        return;
      }
      const record =
        /^records\/(variables|assets|animations|materials|archetypes|scripts|rooms|maps|characters|interactables|verbs|interactions|dialogues|scenes|tests)\/([^/]+)\.yaml$/u.exec(
          file,
        );
      files.add(
        record
          ? recordFile(
              record[1] as
                | 'variables'
                | 'assets'
                | 'animations'
                | 'materials'
                | 'archetypes'
                | 'scripts'
                | 'rooms'
                | 'maps'
                | 'characters'
                | 'interactables'
                | 'verbs'
                | 'interactions'
                | 'dialogues'
                | 'scenes'
                | 'tests',
              record[2]!,
            )
          : file,
      );
    });
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
  observedRevision?: ProjectWorkspaceFileRevision,
): Promise<ProjectWorkspaceFileRevision | null> {
  try {
    const absolute = fileSystem.joinPath(projectRoot, file);
    await assertProjectWorkspacePathContained(fileSystem, projectRoot, absolute);
    if (observedRevision) return observedRevision;
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
  // The admitted snapshot already contains descriptors for every source owner.
  // Reuse the owner index instead of rediscovering authored sources once per
  // invalidated contribution.
  const relevantDescriptors = contributionKeys
    ? descriptorsForContributionKeys(snapshot, contributionKeys)
    : snapshot.externalSourceDescriptors;
  const descriptorsByKey = new Map<string, AuthoringLuaSourceDescriptor[]>();
  for (const descriptor of relevantDescriptors) {
    const list = descriptorsByKey.get(descriptor.contributionKey) ?? [];
    list.push(descriptor);
    descriptorsByKey.set(descriptor.contributionKey, list);
  }
  const requiredAssetIds = contributionKeys
    ? new Set(
        [...contributionKeys].flatMap((key) =>
          collectAuthoringSourceRequirements(
            snapshot.project,
            key,
            descriptorsByKey.get(key) ?? [],
          ),
        ),
      )
    : new Set(collectAuthoringSourceRequirements(snapshot.project, undefined, relevantDescriptors));
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

/** Failed revalidations must not inherit an earlier generation's successful proof. */
function failedWorkspaceSourceProofs(
  project: AuthoringProject,
  sourceSnapshot: Awaited<ReturnType<typeof buildWorkspaceSourceAnalysisSnapshot>>,
): ReadonlySet<string> {
  const recheckedPaths = new Set(sourceSnapshot.sources.entriesByProjectPath?.keys() ?? []);
  for (const assetId of sourceSnapshot.sources.entriesByAssetId.keys()) {
    const asset = parseAssetData(project.assets[assetId]?.data);
    if (asset) recheckedPaths.add(asset.source.path);
  }
  return new Set(
    [...recheckedPaths].filter((path) => !sourceSnapshot.externalSourceRevisions.has(path)),
  );
}

function ownershipFor(
  project: AuthoringProject,
  scriptSourcePaths: Readonly<Record<string, string>> = {},
): Readonly<Record<string, ProjectWorkspaceSaveUnitFileOwnership>> {
  const result: Record<string, ProjectWorkspaceSaveUnitFileOwnership> = {
    'project:settings': {
      files: ['project.yaml'],
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
    'collection:traits': { files: ['traits.yaml'], paths: ['/traits'] },
    'project:localization': {
      files: Object.keys(projectWorkspaceLocalizationFiles(project.localization)),
      paths: ['/localization'],
    },
    'project:chapters': {
      files: ['editor.yaml'],
      paths: ['/editor/chapters'],
    },
    'project:tags': { files: ['editor.yaml'], paths: ['/editor/tags'] },
    'project:platform-export-profiles': {
      files: ['project.yaml'],
      paths: ['/export/runtime', '/export/profiles'],
    },
    'editor:organization': {
      files: ['editor.yaml'],
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
      files.push('editor.yaml');
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

export function externalDescriptors(
  project: AuthoringProject,
  scriptSourcePaths: Readonly<Record<string, string>> = {},
  sourceTexts?: ReadonlyMap<string, string>,
  contributionKeys?: ReadonlySet<string>,
  rawDescriptors?: readonly AuthoringLuaSourceDescriptor[],
): readonly AuthoringLuaSourceDescriptor[] {
  return (rawDescriptors ?? collectAuthoringLuaSources(project, contributionKeys)).map(
    (descriptor) => {
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
    },
  );
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

function sparseTrackedEditorOrganization(
  editorState: EditorProjectState,
  previousText?: string,
  keepCommentedDefaults = false,
): Record<string, unknown> {
  const previous = previousText
    ? (projectWorkspaceSourceCodec('editor.yaml').decode(previousText) as Record<string, unknown>)
    : {};
  const notes =
    keepCommentedDefaults && previousText ? annotatedYamlPaths(previousText) : new Set<string>();
  const keep = (path: string) =>
    [...notes].some((note) => note === path || note.startsWith(`${path}.`));
  const previousChapters = (previous.chapters ?? {}) as Record<string, unknown>;
  const previousTags = (previous.tags ?? {}) as Record<string, unknown>;
  const chapterRecords = editorState.chapters?.records ?? {};
  const chapterAssignments = editorState.chapters?.assignments ?? {};
  const tagRecords = editorState.tags?.records ?? {};
  const chapters: Record<string, unknown> = {};
  if (
    Object.keys(chapterRecords).length ||
    (Object.hasOwn(previousChapters, 'records') &&
      (JSON.stringify(previousChapters.records) === JSON.stringify(chapterRecords) ||
        keep('chapters.records')))
  )
    chapters.records = chapterRecords;
  if (
    Object.keys(chapterAssignments).length ||
    (Object.hasOwn(previousChapters, 'assignments') &&
      (JSON.stringify(previousChapters.assignments) === JSON.stringify(chapterAssignments) ||
        keep('chapters.assignments')))
  )
    chapters.assignments = chapterAssignments;
  const tags: Record<string, unknown> = {};
  if (
    Object.keys(tagRecords).length ||
    (Object.hasOwn(previousTags, 'records') &&
      (JSON.stringify(previousTags.records) === JSON.stringify(tagRecords) || keep('tags.records')))
  )
    tags.records = tagRecords;
  const previousMetadata = (previous.recordMetadata ?? {}) as Record<string, unknown>;
  const recordMetadata = Object.fromEntries(
    Object.entries(editorState.recordMetadata ?? {}).map(([collection, entries]) => {
      const priorRecords = (previousMetadata[collection] ?? {}) as Record<string, unknown>;
      return [
        collection,
        Object.fromEntries(
          Object.entries(entries).map(([id, metadata]) => {
            const prior = (priorRecords[id] ?? {}) as Record<string, unknown>;
            const { tags: assignedTags, ...other } = metadata;
            return [
              id,
              {
                ...(assignedTags.length ||
                (Object.hasOwn(prior, 'tags') &&
                  (JSON.stringify(prior.tags) === JSON.stringify(assignedTags) ||
                    keep(`recordMetadata.${collection}.${id}.tags`)))
                  ? { tags: assignedTags }
                  : {}),
                ...other,
              },
            ];
          }),
        ),
      ];
    }),
  );
  return {
    chapters,
    tags,
    recordMetadata: Object.fromEntries(
      Object.entries(recordMetadata).filter(
        ([collection, records]) =>
          Object.keys(records as Record<string, unknown>).length > 0 ||
          (Object.hasOwn(previousMetadata, collection) &&
            (JSON.stringify(previousMetadata[collection]) === JSON.stringify(records) ||
              keep(`recordMetadata.${collection}`))),
      ),
    ),
  };
}

/** Do not materialize defaults that were absent in the admitted YAML source on unrelated edits. */
function preserveManifestOmissions(
  projected: Record<string, unknown>,
  previousText?: string,
): Record<string, unknown> {
  if (previousText === undefined) return projected;
  const previousSource = projectWorkspaceSourceCodec('project.yaml').decode(previousText);
  const normalized = workspaceManifestSchema.parse(previousSource);
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const preserve = (source: unknown, before: unknown, next: unknown): unknown => {
    if (Array.isArray(source) && Array.isArray(before) && Array.isArray(next)) {
      // Preserve provenance only where the original item can be matched unambiguously.
      const byId = new Map<string, number>();
      for (let i = 0; i < before.length; i += 1) {
        if (object(before[i]) && typeof before[i].id === 'string') byId.set(before[i].id, i);
      }
      return next.map((item, i) => {
        const oldIndex = object(item) && typeof item.id === 'string' ? byId.get(item.id) : i;
        return oldIndex !== undefined && oldIndex < source.length && oldIndex < before.length
          ? preserve(source[oldIndex], before[oldIndex], item)
          : item;
      });
    }
    if (!object(source) || !object(before) || !object(next)) return next;
    const result = { ...next };
    for (const [key, value] of Object.entries(next)) {
      if (!Object.hasOwn(source, key)) {
        if (Object.hasOwn(before, key) && JSON.stringify(before[key]) === JSON.stringify(value))
          delete result[key];
      } else if (Object.hasOwn(before, key)) {
        result[key] = preserve(source[key], before[key], value);
      }
    }
    return result;
  };
  return preserve(previousSource, normalized, projected) as Record<string, unknown>;
}

export function projectWorkspaceFile(
  project: AuthoringProject,
  editorState: EditorProjectState,
  scriptSourcePaths: Readonly<Record<string, string>>,
  file: string,
  previousText?: string,
  keepCommentedDefaults = false,
  sourceFiles?: ReadonlySet<string>,
): string | undefined {
  if (file === 'project.yaml')
    return projectWorkspaceSourceCodec(file).encode(
      preserveManifestOmissions(
        {
          schema: PROJECT_WORKSPACE_SCHEMA,
          schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
          project: project.project,
          settings: project.settings,
          export: project.export,
          bootstrapModule: project.bootstrapModule,
          ...(project.undefinedInteractionProgram !== null ||
          (previousText !== undefined &&
            Object.hasOwn(
              projectWorkspaceSourceCodec(file).decode(previousText) as object,
              'undefinedInteractionProgram',
            ) &&
            (workspaceManifestSchema.parse(projectWorkspaceSourceCodec(file).decode(previousText))
              .undefinedInteractionProgram === null ||
              (keepCommentedDefaults &&
                [...annotatedYamlPaths(previousText)].some(
                  (note) =>
                    note === 'undefinedInteractionProgram' ||
                    note.startsWith('undefinedInteractionProgram.'),
                ))))
            ? { undefinedInteractionProgram: project.undefinedInteractionProgram }
            : {}),
          ...(project.entrypoint !== null ||
          (previousText !== undefined &&
            Object.hasOwn(
              projectWorkspaceSourceCodec(file).decode(previousText) as object,
              'entrypoint',
            ) &&
            (workspaceManifestSchema.parse(projectWorkspaceSourceCodec(file).decode(previousText))
              .entrypoint === null ||
              (keepCommentedDefaults &&
                [...annotatedYamlPaths(previousText)].some(
                  (note) => note === 'entrypoint' || note.startsWith('entrypoint.'),
                ))))
            ? { entrypoint: project.entrypoint }
            : {}),
          inventories: project.inventories,
          interactableInstances: project.interactableInstances,
        },
        previousText,
      ),
      workspaceManifestSchema,
      previousText,
    );
  if (file === 'traits.yaml')
    return projectWorkspaceSourceCodec(file).encode(
      project.traits,
      traitsWorkspaceSchema,
      previousText,
    );
  if (file === 'editor.yaml')
    return projectWorkspaceSourceCodec(file).encode(
      sparseTrackedEditorOrganization(editorState, previousText, keepCommentedDefaults),
      trackedEditorOrganizationSchema,
      previousText,
    );
  const localization = projectWorkspaceLocalizationFile(project.localization, file, previousText);
  if (localization !== undefined) return localization;
  const layoutMatch = /^records\/layouts\/([^/]+)\/layout\.(yaml|rml|rcss|lua)$/u.exec(file);
  if (layoutMatch) {
    const id = layoutMatch[1]!;
    const channel = layoutMatch[2]!;
    const original = project.layouts[id];
    if (!original) return undefined;
    // A loaded Lua `none` selector is represented by empty inline Lua in the
    // effective Project. Retain the physical absence of its companion on saves.
    const preservesAbsentLua =
      original.data.lua.sourceMode === 'inline' &&
      original.data.lua.sourceText === '' &&
      sourceFiles !== undefined &&
      sourceFiles.has(`records/layouts/${id}/layout.yaml`) &&
      !sourceFiles.has(layoutFile(id, 'lua'));
    if (channel !== 'yaml') {
      const source = original.data[channel as 'rml' | 'rcss' | 'lua'];
      if (channel === 'lua' && preservesAbsentLua) return undefined;
      return source.sourceMode === 'inline'
        ? projectWorkspaceSourceCodec(file).encode(source.sourceText)
        : undefined;
    }
    const record = structuredClone(original) as Record<string, unknown>;
    const data = record.data as Record<string, Record<string, unknown>>;
    for (const sourceChannel of ['rml', 'rcss', 'lua'] as const) {
      const source = data[sourceChannel]!;
      if (sourceChannel === 'lua' && preservesAbsentLua)
        data[sourceChannel] = { sourceMode: 'none' };
      else if (source.sourceMode === 'inline') data[sourceChannel] = { sourceMode: 'file' };
      else if (source.sourceMode === 'asset')
        data[sourceChannel] = { sourceMode: 'asset', sourceAsset: source.sourceAsset };
      else data[sourceChannel] = { sourceMode: 'none' };
    }
    return projectWorkspaceSourceCodec(file).encode(
      record,
      authoringRecordSchemas.layouts,
      previousText,
      keepCommentedDefaults,
    );
  }
  const recordMatch = /^records\/([^/]+)\/([^/]+)\.yaml$/u.exec(file);
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
        data.source = { kind: 'project-file', path: sourcePath };
      }
    }
    return projectWorkspaceSourceCodec(file).encode(
      record,
      authoringRecordSchemas[collection],
      previousText,
      keepCommentedDefaults,
    );
  }
  for (const [id, record] of Object.entries(project.scripts)) {
    const source = record.data.source;
    if (source.kind !== 'inline-lua') continue;
    if ((scriptSourcePaths[id] ?? `scripts/${id}.lua`) === file)
      return projectWorkspaceSourceCodec(file).encode(source.source);
  }
  return undefined;
}

/** Full projection enumerates paths, then uses the same file codec as selective saves. */
export function projectWorkspaceFiles(
  project: AuthoringProject,
  editorState: EditorProjectState,
  scriptSourcePaths: Readonly<Record<string, string>> = {},
  sourceFiles?: ReadonlySet<string>,
  previousTexts?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const files: Record<string, string> = {};
  const add = (file: string) => {
    const text = projectWorkspaceFile(
      project,
      editorState,
      scriptSourcePaths,
      file,
      previousTexts?.[file],
      false,
      sourceFiles,
    );
    if (text !== undefined) files[file] = text;
  };
  add('project.yaml');
  add('traits.yaml');
  add('editor.yaml');
  for (const file of projectWorkspaceLocalizationPaths(project.localization)) add(file);
  for (const collection of authoringCollectionKeys)
    for (const id of Object.keys(project[collection]).sort(
      compareProjectWorkspaceUnicodeCodePoints,
    )) {
      add(recordFile(collection, id));
      if (collection === 'layouts') {
        for (const channel of ['rml', 'rcss', 'lua'] as const) add(layoutFile(id, channel));
      } else if (collection === 'scripts') {
        const source = project.scripts[id]?.data.source;
        if (source?.kind === 'inline-lua') add(scriptSourcePaths[id] ?? `scripts/${id}.lua`);
      }
    }
  return sortKeys(files);
}
export { projectWorkspaceLocalStateFile } from '../editor-local-state-file';

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

export interface ProjectWorkspaceCommentImpact extends YamlCommentImpact {
  readonly file: string;
}

export interface ProjectWorkspaceCommentNotice {
  readonly file: string;
  readonly path: string;
  readonly comment: string;
  readonly oldId: string;
}

// Exact committed source belongs to the snapshot generation, never reconstructed from semantics.
const committedSourceTexts = new WeakMap<
  LoadedProjectWorkspaceSnapshot,
  ReadonlyMap<string, string>
>();

export interface ProjectWorkspaceWriteOptions {
  readonly commentDisposition?: 'keep' | 'remove' | 'delete';
  /** Prepare the same source-aware transaction without committing or writing editor state. */
  readonly dryRun?: boolean;
  /** Undo templates seed only recreated nodes, never overwrite live annotations. */
  readonly sourceRestorations?: Readonly<Record<string, string>>;
  readonly transactionId?: string;
  readonly expectedFileRevisions?: Readonly<Record<string, ProjectWorkspaceExpectedRevision>>;
  readonly targetFiles?: readonly string[];
  readonly operationLabel?: string;
  /** Explicit identity moves, never inferred from similar record values (duplicates are fresh source). */
  readonly identityRemap?: readonly { fromPath: string; toPath: string }[];
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
// Canonical localization source views are expensive to derive, but immutable
// for an admitted snapshot. Reuse them for graph construction and font coverage.
const sharedSnapshotLocalizationSourceViews = new WeakMap<
  ProjectWorkspaceSnapshot,
  ReturnType<typeof localizationMessageSourceViews>
>();

function projectedMessageOnlyLocalizationViews(
  previous: ProjectWorkspaceSnapshot,
  current: AuthoringProject,
  changedPaths: readonly string[],
): ReturnType<typeof localizationMessageSourceViews> | null {
  if (changedPaths.length !== 1 || changedPaths[0] !== LOCALIZATION_MESSAGES_FILE) return null;
  const sourceViews = sharedSnapshotLocalizationSourceViews.get(previous);
  return sourceViews
    ? updateLocalizationMessageSourceViews(previous.project, current, sourceViews)
    : null;
}
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

function descriptorContributionKeysForSourcePaths(
  snapshot: ProjectWorkspaceSnapshot,
  changedPaths: readonly string[],
): ReadonlySet<string> | null {
  const keys = new Set<string>();
  for (const relativePath of changedPaths) {
    const owners = sourceContributionOwnerPaths(relativePath, snapshot.scriptSourcePaths);
    for (const owner of owners) {
      const root = recordOwnerRoot(owner);
      if (!root) continue;
      const segments = parseJsonPointer(root);
      if (segments.length !== 2 || !isAuthoringCollectionKey(segments[0]!)) return null;
      keys.add(recordContributionKey(segments[0] as AuthoringCollectionKey, segments[1]!));
    }
  }
  return keys;
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

/** Compare schema-projected semantics, not physical JSON/YAML style or source comments. */
function semanticWorkspaceJsonUnchanged(
  changedPaths: readonly string[],
  before: AuthoringProject,
  after: AuthoringProject,
  scriptSourcePaths: Readonly<Record<string, string>>,
): boolean {
  return (
    changedPaths.length > 0 &&
    changedPaths.every((path) => {
      if (projectWorkspaceSourceCodec(path).kind === 'text') return false;
      const previous = projectWorkspaceFile(before, before.editor, scriptSourcePaths, path);
      return (
        previous !== undefined &&
        previous === projectWorkspaceFile(after, after.editor, scriptSourcePaths, path)
      );
    })
  );
}

function changedValidationContributionKeys(
  state: SnapshotValidationState,
  changedSourcePaths: readonly string[],
  effects: WorkspaceEditEffects,
): ReadonlySet<string> {
  if (effects.semanticInputsUnchanged) return new Set();
  if (effects.projectNameOnly) {
    const keys = new Set<string>();
    for (const [key, contribution] of state.byKey)
      if (
        contribution.inputPaths.some((path) => path === '/project' || path.startsWith('/project/'))
      )
        keys.add(key);
    return keys;
  }
  const keys = new Set(state.unresolvedKeys);
  for (const path of changedSourcePaths)
    for (const key of state.keysBySourcePath.get(path) ?? []) keys.add(key);
  if (effects.presentationRecords) {
    const localKeys = new Set<string>();
    for (const { collection, id } of effects.presentationRecords)
      for (const prefix of [
        `workspace:identity:${collection}:${id}`,
        `workspace:record:${collection}:${id}`,
        `workspace:archetype-definition:${id}`,
      ])
        if (keys.has(prefix)) localKeys.add(prefix);
    return localKeys;
  }
  for (const phase of ['references', 'identities', 'translations'] as const)
    if (!effects.localizationPhases.includes(phase)) keys.delete(`workspace:localization-${phase}`);
  // The editor-metadata check validates only editor.yaml recordMetadata membership. Existing-source
  // reconciliation cannot add/remove a record identity; traits.yaml is the one non-structural file
  // whose contents can change metadata target membership, so unrelated source edits can reuse it.
  if (
    keys.has('workspace:editor-metadata') &&
    changedSourcePaths.every((path) => path !== 'editor.yaml' && path !== 'traits.yaml')
  )
    keys.delete('workspace:editor-metadata');
  if (process.env.NOVELTEA_CLI_VALIDATION_PROFILE === '1') {
    const families = new Map<string, number>();
    for (const key of keys) {
      const family = key.startsWith('workspace:record:')
        ? key.split(':').slice(0, 3).join(':')
        : key.split(':').slice(0, 2).join(':');
      families.set(family, (families.get(family) ?? 0) + 1);
    }
    console.error(
      `[validation-invalidation] ${JSON.stringify({
        stage: 'semantic',
        changedSourcePaths,
        invalidatedChecks: keys.size,
        unresolvedChecks: state.unresolvedKeys.size,
        unresolvedInputs: [...state.unresolvedKeys].map((key) => ({
          key,
          paths: state.byKey
            .get(key)
            ?.inputPaths.filter(
              (path) => path === '/' || path === '/editor' || path.startsWith('/editor/'),
            ),
        })),
        families: [...families].sort((a, b) => b[1] - a[1]),
        sources: changedSourcePaths.map((path) => ({
          path,
          directConsumers: state.keysBySourcePath.get(path)?.length ?? 0,
        })),
      })}`,
    );
  }
  return keys;
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
  changedSourcePaths: readonly string[],
  effects: WorkspaceEditEffects,
): ReadonlySet<string> | null {
  if (effects.graph.kind === 'contributions') return effects.graph.keys;
  if (effects.graph.kind === 'sources') {
    const keys = new Set<string>();
    const changedFiles = new Set(changedSourcePaths);
    for (const [key, sourcePaths] of analysis.sourcePathsByContributionKey)
      if (sourcePaths.some((path) => changedFiles.has(path))) keys.add(key);
    for (const path of changedSourcePaths) {
      for (const key of analysis.contributions.contributionKeysByDerivationKey.get(
        JSON.stringify(['source-project-file', path]),
      ) ?? [])
        keys.add(key);
    }
    for (const ownerPath of ownerPaths) {
      const root = recordOwnerRoot(ownerPath);
      if (!root) continue;
      const segments = parseJsonPointer(root);
      if (segments.length === 2 && isAuthoringCollectionKey(segments[0]!))
        keys.add(recordContributionKey(segments[0] as AuthoringCollectionKey, segments[1]!));
    }
    if (process.env.NOVELTEA_CLI_VALIDATION_PROFILE === '1')
      console.error(
        `[validation-invalidation] ${JSON.stringify({
          stage: 'graph',
          strategy: 'source-only',
          changedSourcePaths,
          ownerPaths: [...ownerPaths],
          invalidatedContributions: keys.size,
        })}`,
      );
    return keys;
  }
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
  const keys = new Set([...impacted.values()].map(dependencyContributionKeyForNode));
  if (process.env.NOVELTEA_CLI_VALIDATION_PROFILE === '1')
    console.error(
      `[validation-invalidation] ${JSON.stringify({
        stage: 'graph',
        strategy: 'reverse-impact-closure',
        changedSourcePaths,
        ownerPaths: [...ownerPaths],
        rootNodes: roots.length,
        closureNodes: impacted.size,
        invalidatedContributions: keys.size,
      })}`,
    );
  return keys;
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

  private advanceExternalDescriptors(
    base: LoadedProjectWorkspaceSnapshot,
    project: AuthoringProject,
    scriptSourcePaths: Readonly<Record<string, string>>,
    changedPaths: readonly string[],
  ): Readonly<{
    descriptors: readonly AuthoringLuaSourceDescriptor[];
    index: SnapshotExternalDescriptorIndex;
  }> | null {
    const priorIndex = this.snapshotExternalDescriptorIndexes.get(base);
    const contributionKeys = descriptorContributionKeysForSourcePaths(base, changedPaths);
    if (!priorIndex || !contributionKeys) return null;
    if (contributionKeys.size === 0)
      return { descriptors: base.externalSourceDescriptors, index: priorIndex };

    const fresh = externalDescriptors(project, scriptSourcePaths, undefined, contributionKeys);
    const freshByKey = new Map<string, AuthoringLuaSourceDescriptor[]>();
    for (const descriptor of fresh) {
      const values = freshByKey.get(descriptor.contributionKey) ?? [];
      values.push(descriptor);
      freshByKey.set(descriptor.contributionKey, values);
    }
    const changes = new Map<number, AuthoringLuaSourceDescriptor>();
    for (const key of contributionKeys) {
      const indexes = priorIndex.indexesByContributionKey.get(key) ?? [];
      const replacements = freshByKey.get(key) ?? [];
      if (indexes.length !== replacements.length) return null;
      for (let offset = 0; offset < indexes.length; offset += 1) {
        const index = indexes[offset]!;
        const before = base.externalSourceDescriptors[index]!;
        const after = replacements[offset]!;
        if (
          before.contributionKey !== after.contributionKey ||
          before.sourcePath !== after.sourcePath ||
          before.sourceUrl !== after.sourceUrl
        )
          return null;
        changes.set(index, after);
      }
    }
    return {
      descriptors: overlayReadonlyArray(base.externalSourceDescriptors, changes),
      index: priorIndex,
    };
  }

  constructor(
    private readonly fileSystem: ProjectWorkspaceFileSystem,
    transactions?: ProjectWorkspaceTransactionService,
  ) {
    // #519 executable independence tripwire. Importing retained downstream
    // helpers is allowed before #521, but no native CLI candidate may create
    // this retired TypeScript Project authority, even outside the ScriptC
    // island's normal workspace factory.
    if (
      new.target === ProjectWorkspaceService &&
      typeof process !== 'undefined' &&
      process.env.NOVELTEA_CLI_CERTIFICATION === '1' &&
      process.env.NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE === '1' &&
      process.env.NOVELTEA_CLI_CERTIFICATION_POISON_LEGACY_WORKSPACE === '1'
    )
      throw new Error('Native CLI certification reached retired TypeScript workspace authority.');
    this.transactions =
      transactions ??
      new ProjectWorkspaceTransactionService(fileSystem, { isProcessAlive: async () => null }, 1);
  }

  /** Restore in-memory incremental indexes for an already-admitted portable generation. */
  async restoreReusableSnapshotState(
    opened: Extract<ProjectWorkspaceOpenResult, { ok: true }>,
  ): Promise<void> {
    const { snapshot } = opened;
    const aggregate = await aggregateRevisionState(snapshot.fileRevisions);
    snapshotRevisionStates.set(snapshot, aggregate.state);
    this.snapshotExternalDescriptorIndexes.set(
      snapshot,
      createSnapshotExternalDescriptorIndex(snapshot.externalSourceDescriptors),
    );
    this.snapshotValidators.set(snapshot, () => opened.diagnostics);
    this.snapshotValidationStates.set(
      snapshot,
      createSnapshotValidationState(opened.validationContributions),
    );
    this.snapshotSourceOwnerIndexes.set(
      snapshot,
      buildSourceOwnerPathIndex(
        new Map(
          Object.entries(opened.sourceContributions).map(([file, contribution]) => [
            file,
            contribution.ownerPaths,
          ]),
        ),
      ),
    );
    await this.buildDependencyGraphAnalysis(snapshot);
  }

  /**
   * A physical Asset changed but the admitted semantic Project and all authored
   * source fragments are identical. Preserve graph products by snapshot identity,
   * invalidating only source analyses that actually consume changed Asset bytes.
   * Native source authority remains responsible for proving the new generation.
   */
  advanceExternalAssetAuthority(
    previous: LoadedProjectWorkspaceSnapshot,
    next: LoadedProjectWorkspaceSnapshot,
    changedPaths: readonly string[],
  ): void {
    const copy = <T>(cache: WeakMap<ProjectWorkspaceSnapshot, T>) => {
      const current = cache.get(previous);
      if (current !== undefined) cache.set(next, current);
    };
    copy(snapshotRevisionStates);
    copy(this.snapshotValidators);
    copy(this.snapshotValidationStates);
    copy(this.snapshotSourceOwnerIndexes);
    copy(this.snapshotExternalDescriptorIndexes);
    copy(sharedSnapshotLocalizationSourceViews);
    const analysis = this.snapshotDependencyAnalysis.get(previous);
    if (!analysis) return;

    const keys = externalAssetContributionKeys(next.project, changedPaths, analysis.contributions);
    if (keys.size === 0) {
      this.snapshotDependencyAnalysis.set(next, {
        ...analysis,
        work: {
          derivedContributions: 0,
          reusedContributions: analysis.contributions.byKey.size,
          analyzedOwners: 0,
          reusedSourceAnalyses: analysis.sourceAnalyses.size,
          fullProjectTraversals: 0,
        },
      });
      copy(this.snapshotLuaSymbolProjections);
    } else {
      this.snapshotIncrementalDependencySeeds.set(next, {
        base: analysis,
        contributionKeys: keys,
        symbolProjection: this.snapshotLuaSymbolProjections.get(previous),
      });
    }
  }

  /** Merge external Asset consumers into an already reconciled semantic generation. */
  invalidateReconciledExternalAssets(
    previous: LoadedProjectWorkspaceSnapshot,
    next: LoadedProjectWorkspaceSnapshot,
    changedPaths: readonly string[],
  ): void {
    if (changedPaths.length === 0) return;
    const analysis = this.snapshotDependencyAnalysis.get(previous);
    if (!analysis) {
      // No proved base graph: the next analysis must be built from current sources.
      this.snapshotIncrementalDependencySeeds.delete(next);
      this.snapshotDependencyReuse.delete(next);
      return;
    }
    const seed = this.snapshotIncrementalDependencySeeds.get(next);
    if (!seed || seed.base !== analysis) {
      // Reconciliation may have changed structural membership. Never apply a
      // partial Asset patch against a different graph generation.
      this.snapshotIncrementalDependencySeeds.delete(next);
      this.snapshotDependencyReuse.delete(next);
      return;
    }
    const keys = new Set(seed.contributionKeys);
    for (const key of externalAssetContributionKeys(
      next.project,
      changedPaths,
      analysis.contributions,
    ))
      keys.add(key);
    this.snapshotIncrementalDependencySeeds.set(next, { ...seed, contributionKeys: keys });
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
      candidateFiles.forEach((file) => {
        const layout = /^records\/layouts\/([^/]+)\/layout\.yaml$/u.exec(file);
        if (layout) {
          files.add(recordFile('layouts', layout[1]!));
          return;
        }
        const variableMatch =
          /^records\/(variables|assets|animations|materials|archetypes|scripts|rooms|maps|characters|interactables|verbs|interactions|dialogues|scenes|tests)\/([^/]+)\.yaml$/u.exec(
            file,
          );
        files.add(
          variableMatch
            ? recordFile(
                variableMatch[1] as
                  | 'variables'
                  | 'assets'
                  | 'animations'
                  | 'materials'
                  | 'archetypes'
                  | 'scripts'
                  | 'rooms'
                  | 'maps'
                  | 'characters'
                  | 'interactables'
                  | 'verbs'
                  | 'interactions'
                  | 'dialogues'
                  | 'scenes'
                  | 'tests',
                variableMatch[2]!,
              )
            : file,
        );
      });
    }
    return [...files].sort(compareProjectWorkspaceUnicodeCodePoints);
  }

  private assertContained(root: string, candidate: string): Promise<void> {
    return assertProjectWorkspacePathContained(this.fileSystem, root, candidate);
  }
  async discover(projectRoot: string): Promise<{ projectRoot: string; manifestPath: string }> {
    const root = this.fileSystem.resolvePath(projectRoot);
    return { projectRoot: root, manifestPath: this.fileSystem.joinPath(root, 'project.yaml') };
  }
  async reconcileExistingSources(
    base: Extract<ProjectWorkspaceOpenResult, { ok: true }>,
    changedPaths: readonly string[],
  ): Promise<ProjectWorkspaceOpenResult | null> {
    const reconcileStarted = Date.now();
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
        const recordMatch = /^records\/([^/]+)\/([^/]+)(?:\.yaml|\/layout\.yaml)$/u.exec(
          relativePath,
        );
        const layoutSourceMatch = /^records\/layouts\/([^/]+)\/layout\.(rml|rcss|lua)$/u.exec(
          relativePath,
        );
        const scriptSourceId = priorContribution.ownerPaths
          .map((path) => parseJsonPointer(path))
          .find((segments) => segments[0] === 'scripts' && segments.length >= 2)?.[1];

        if (relativePath === 'project.yaml') {
          const parsed = workspaceManifestSchema.safeParse(
            projectWorkspaceSourceCodec(relativePath).decode(text),
          );
          if (!parsed.success) return null;
          project = {
            ...project,
            project: parsed.data.project,
            settings: parsed.data.settings,
            export: parsed.data.export,
            bootstrapModule: parsed.data.bootstrapModule,
            undefinedInteractionProgram: parsed.data.undefinedInteractionProgram,
            entrypoint: parsed.data.entrypoint,
            inventories: parsed.data.inventories,
            interactableInstances: parsed.data.interactableInstances,
          };
        } else if (relativePath === 'traits.yaml') {
          const parsed = traitsWorkspaceSchema.safeParse(
            projectWorkspaceSourceCodec(relativePath).decode(text),
          );
          if (!parsed.success) return null;
          project = { ...project, traits: parsed.data };
        } else if (relativePath === 'editor.yaml') {
          const raw = projectWorkspaceSourceCodec(relativePath).decode(text) as Record<
            string,
            unknown
          >;
          const parsed = parseTrackedEditorOrganization(raw);
          if (!parsed) return null;
          project = { ...project, editor: { ...project.editor, ...parsed } };
        } else if (relativePath === LOCALIZATION_POLICY_FILE) {
          const parsed = localizationPolicyFragmentSchema.safeParse(
            projectWorkspaceSourceCodec(relativePath).decode(text),
          );
          if (!parsed.success) return null;
          project = { ...project, localization: { ...project.localization, ...parsed.data } };
        } else if (relativePath === LOCALIZATION_MESSAGES_FILE) {
          const parsed = localizationMessagesFragmentSchema.safeParse(
            projectWorkspaceSourceCodec(relativePath).decode(text),
          );
          if (!parsed.success) return null;
          project = { ...project, localization: { ...project.localization, ...parsed.data } };
        } else if (relativePath === LOCALIZATION_USAGE_NOTES_FILE) {
          const parsed = localizationUsageNotesFragmentSchema.safeParse(
            projectWorkspaceSourceCodec(relativePath).decode(text),
          );
          if (!parsed.success) return null;
          project = {
            ...project,
            localization: { ...project.localization, usageNotes: parsed.data },
          };
        } else if (relativePath === LOCALIZATION_TRACKING_FILE) {
          const parsed = localizationTrackingFragmentSchema.safeParse(
            projectWorkspaceSourceCodec(relativePath).decode(text),
          );
          if (!parsed.success) return null;
          project = {
            ...project,
            localization: { ...project.localization, sourceMessageTracking: parsed.data },
          };
        } else if (relativePath === LOCALIZATION_ORPHANS_FILE) {
          const parsed = localizationOrphansFragmentSchema.safeParse(
            projectWorkspaceSourceCodec(relativePath).decode(text),
          );
          if (!parsed.success) return null;
          project = {
            ...project,
            localization: { ...project.localization, orphanedMessages: parsed.data },
          };
        } else if (/^i18n\/locales\/([^/]+)\.yaml$/u.test(relativePath)) {
          const locale = /^i18n\/locales\/([^/]+)\.yaml$/u.exec(relativePath)![1]!;
          const parsed = localizationTranslationSchema.safeParse(
            projectWorkspaceSourceCodec(relativePath).decode(text),
          );
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
        } else if (/^i18n\/assets\/([^/]+)\.yaml$/u.test(relativePath)) {
          const locale = /^i18n\/assets\/([^/]+)\.yaml$/u.exec(relativePath)![1]!;
          const parsed = localizationAssetsLocaleFragmentSchema.safeParse(
            projectWorkspaceSourceCodec(relativePath).decode(text),
          );
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
          const raw = projectWorkspaceSourceCodec(relativePath).decode(text) as Record<
            string,
            unknown
          >;
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
                data[channel] =
                  channel === 'lua'
                    ? { sourceMode: 'inline', sourceText: priorSource.sourceText }
                    : {
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
                data[channel] = { sourceMode: 'inline', sourceText: '' };
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
                    [channel]:
                      channel === 'lua'
                        ? { sourceMode: 'inline', sourceText: text }
                        : { sourceMode: 'inline', sourceText: text, sourceAsset: null },
                  },
                },
              },
              recordSemanticTraversal,
            ),
          };
        } else if (/^shaders\/.+\.sc$/u.test(relativePath)) {
          // Unowned authored shader stage/include source: retain the current
          // semantic Project, but advance its exact physical source revision.
          // Shader validation itself remains under native compiler authority.
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
        if (projectWorkspaceSourceCodec(relativePath).kind !== 'text') {
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
            parsed: projectWorkspaceSourceCodec(relativePath).decode(normalizedText),
            ...(relativePath.endsWith('.yaml') ? { sourceText: text } : {}),
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
    const readFinished = Date.now();
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
    const effects = classifyWorkspaceEditEffects(
      changedPaths,
      base.snapshot.project,
      project,
      semanticWorkspaceJsonUnchanged(
        changedPaths,
        base.snapshot.project,
        project,
        base.snapshot.scriptSourcePaths,
      ),
    );
    const semanticMembershipChanged = effects.membershipChanged;
    if (semanticMembershipChanged) fullProjectTraversals += 1;
    const invalidValidationKeys =
      priorValidationState && !semanticMembershipChanged
        ? changedValidationContributionKeys(priorValidationState, changedPaths, effects)
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
        } else if (overlappingFiles.length === 0) files.add('project.yaml');
      }
      return [...files].sort(compareProjectWorkspaceUnicodeCodePoints).map((path) => ({
        path,
        contentHash: fileRevisions[path]!.contentHash,
      }));
    };
    const projectedLocalizationViews =
      changedTextSources.size === 0
        ? projectedMessageOnlyLocalizationViews(base.snapshot, project, changedPaths)
        : null;
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
          ...(projectedLocalizationViews
            ? { localizationSourceViews: projectedLocalizationViews }
            : {}),
          resolveInputs: resolveValidationInputs,
        };
    const validation = validateAdmittedAuthoringProject(project, validationReuse);
    const validationFinished = Date.now();
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
    const revisionFinished = Date.now();
    const priorAnalysis = this.snapshotDependencyAnalysis.get(base.snapshot);
    const impactedOwnerPaths = new Set(changedOwnerPaths.values().flatMap((paths) => [...paths]));
    const incrementalDependencyKeys =
      priorAnalysis && !semanticMembershipChanged
        ? incrementalDependencyContributionKeys(
            priorAnalysis,
            impactedOwnerPaths,
            changedPaths,
            effects,
          )
        : null;
    const priorDescriptorIndex = this.snapshotExternalDescriptorIndexes.get(base.snapshot);
    let externalSourceDescriptors = base.snapshot.externalSourceDescriptors;
    const changedRecordKeys = new Set<string>();
    for (const path of changedPaths) {
      const match = /^records\/([^/]+)\/([^/]+)(?:\.yaml|\/layout\.yaml)$/u.exec(path);
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
    if (projectedLocalizationViews)
      sharedSnapshotLocalizationSourceViews.set(snapshot, projectedLocalizationViews);
    snapshotRevisionStates.set(snapshot, aggregate.state);
    if (project === base.snapshot.project) {
      const views = sharedSnapshotLocalizationSourceViews.get(base.snapshot);
      if (views) sharedSnapshotLocalizationSourceViews.set(snapshot, views);
    }
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
    const coverageInputsChanged = effects.coverageInputsChanged;
    const indexesFinished = Date.now();
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
          ...(process.env.NOVELTEA_CLI_VALIDATION_PROFILE === '1'
            ? {
                residentReconcileMs: {
                  readAndProject: readFinished - reconcileStarted,
                  semanticChecks: validationFinished - readFinished,
                  revisionAndDiagnostics: revisionFinished - validationFinished,
                  snapshotIndexes: indexesFinished - revisionFinished,
                },
              }
            : {}),
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
          localizationCoverageInputsChanged: coverageInputsChanged,
          localizationCoverageDependencyRevision: coverageInputsChanged
            ? workspaceRevision
            : base.sourceWork.localizationCoverageDependencyRevision,
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
    const sourceContributionChanges: Record<string, ProjectWorkspaceSourceContribution> = {};
    const changedOwnerPaths = new Map<string, readonly string[]>();
    let parsedJsonSources = 0;
    let readTextSources = 0;
    let projectedJsonSources = 0;
    let sourceMembershipChanged = false;

    for (const relativePath of [...new Set(changedPaths)].sort(
      compareProjectWorkspaceUnicodeCodePoints,
    )) {
      const prior = base.sourceContributions[relativePath];
      const text =
        committedSourceTexts.get(committedSnapshot)?.get(relativePath) ??
        projectWorkspaceFile(
          committedSnapshot.project,
          committedSnapshot.project.editor,
          committedSnapshot.scriptSourcePaths,
          relativePath,
          prior?.kind === 'json' ? prior.sourceText : undefined,
        );
      const revision = committedSnapshot.fileRevisions[relativePath];
      if (text === undefined || !revision) {
        if (prior) changedOwnerPaths.set(relativePath, prior.ownerPaths);
        sourceMembershipChanged ||= prior !== undefined;
        continue;
      }
      const ownerPaths = sourceContributionOwnerPaths(
        relativePath,
        committedSnapshot.scriptSourcePaths,
      );
      sourceMembershipChanged ||= prior === undefined;
      changedOwnerPaths.set(relativePath, ownerPaths);
      if (projectWorkspaceSourceCodec(relativePath).kind !== 'text') {
        parsedJsonSources += 1;
        projectedJsonSources += 1;
        sourceContributionChanges[relativePath] = Object.freeze({
          path: relativePath,
          ...revision,
          kind: 'json' as const,
          parsed: projectWorkspaceSourceCodec(relativePath).decode(text),
          ...(relativePath.endsWith('.yaml') ? { sourceText: text } : {}),
          schemaValid: true as const,
          ownerPaths,
          localDiagnostics: Object.freeze([]),
        });
      } else {
        readTextSources += 1;
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
    }

    const effects = classifyWorkspaceEditEffects(
      changedPaths,
      base.snapshot.project,
      committedSnapshot.project,
      semanticWorkspaceJsonUnchanged(
        changedPaths,
        base.snapshot.project,
        committedSnapshot.project,
        base.snapshot.scriptSourcePaths,
      ),
    );
    const semanticMembershipChanged = effects.membershipChanged || sourceMembershipChanged;
    const priorSourceOwnerPathIndex = this.snapshotSourceOwnerIndexes.get(base.snapshot);
    const ownerMembershipChanged = [...changedOwnerPaths].some(([relativePath, ownerPaths]) => {
      const prior = base.sourceContributions[relativePath]?.ownerPaths;
      return (
        !prior ||
        prior.length !== ownerPaths.length ||
        prior.some((path, index) => path !== ownerPaths[index])
      );
    });
    const incrementalSourceOwnership =
      !semanticMembershipChanged &&
      !ownerMembershipChanged &&
      priorSourceOwnerPathIndex !== undefined;
    let sourceContributions: ProjectWorkspaceSourceContributions;
    let sourceOwnerPathIndex: SourceOwnerPathIndex;
    if (incrementalSourceOwnership) {
      sourceContributions = overlayRecord(base.sourceContributions, sourceContributionChanges);
      sourceOwnerPathIndex = priorSourceOwnerPathIndex;
    } else {
      const rebuiltSourceContributions = {
        ...base.sourceContributions,
        ...sourceContributionChanges,
      };
      for (const path of changedPaths)
        if (!committedSnapshot.fileRevisions[path]) delete rebuiltSourceContributions[path];
      sourceContributions = rebuiltSourceContributions;
      sourceOwnerPathIndex = buildSourceOwnerPathIndex(
        new Map(
          Object.entries(sourceContributions).map(([file, contribution]) => [
            file,
            contribution.ownerPaths,
          ]),
        ),
      );
    }
    const priorValidationState = this.snapshotValidationStates.get(base.snapshot);
    const changedValidationKeys =
      priorValidationState && !semanticMembershipChanged
        ? changedValidationContributionKeys(priorValidationState, changedPaths, effects)
        : null;
    const resolveValidationInputs: AuthoringValidationReuse['resolveInputs'] = (paths) => {
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
        } else if (overlappingFiles.length === 0) resolvedFiles.add('project.yaml');
      }
      return [...resolvedFiles].sort(compareProjectWorkspaceUnicodeCodePoints).map((path) => ({
        path,
        contentHash: committedSnapshot.fileRevisions[path]!.contentHash,
      }));
    };
    const projectedLocalizationViews = projectedMessageOnlyLocalizationViews(
      base.snapshot,
      committedSnapshot.project,
      changedPaths,
    );
    if (projectedLocalizationViews)
      sharedSnapshotLocalizationSourceViews.set(committedSnapshot, projectedLocalizationViews);
    const validation = validateAdmittedAuthoringProject(
      committedSnapshot.project,
      semanticMembershipChanged
        ? { contributions: [], resolveInputs: resolveValidationInputs }
        : {
            contributions: base.validationContributions,
            ...(priorValidationState && changedValidationKeys
              ? {
                  contributionsByKey: priorValidationState.byKey,
                  changedContributionKeys: changedValidationKeys,
                  contributionIndexes: priorValidationState.indexByKey,
                  baseDiagnostics: base.diagnostics,
                }
              : {}),
            changedSourcePaths: new Set(changedPaths),
            ...(projectedLocalizationViews
              ? { localizationSourceViews: projectedLocalizationViews }
              : {}),
            resolveInputs: resolveValidationInputs,
          },
    );
    const changedLocalDiagnostics = sourceLocalDiagnostics(
      validation.diagnostics,
      changedOwnerPaths,
    );
    for (const [relativePath, ownerPaths] of changedOwnerPaths) {
      const contribution =
        sourceContributionChanges[relativePath] ?? sourceContributions[relativePath];
      if (!contribution) continue;
      sourceContributionChanges[relativePath] = Object.freeze({
        ...contribution,
        ownerPaths,
        localDiagnostics: Object.freeze([...(changedLocalDiagnostics.get(relativePath) ?? [])]),
      });
    }
    sourceContributions = incrementalSourceOwnership
      ? overlayRecord(base.sourceContributions, sourceContributionChanges)
      : Object.freeze({ ...sourceContributions, ...sourceContributionChanges });

    this.snapshotValidators.set(committedSnapshot, () => validation.diagnostics);
    this.snapshotValidationStates.set(
      committedSnapshot,
      priorValidationState && changedValidationKeys && !semanticMembershipChanged
        ? advanceSnapshotValidationState(
            priorValidationState,
            validation.contributions,
            changedValidationKeys,
          )
        : createSnapshotValidationState(validation.contributions),
    );
    this.snapshotSourceOwnerIndexes.set(committedSnapshot, sourceOwnerPathIndex);
    const committedDescriptorIndex = this.snapshotExternalDescriptorIndexes.get(committedSnapshot);
    const priorDescriptorIndex = this.snapshotExternalDescriptorIndexes.get(base.snapshot);
    if (committedDescriptorIndex) {
      // write() already advanced this index when descriptor topology remained stable.
    } else if (
      !semanticMembershipChanged &&
      priorDescriptorIndex &&
      committedSnapshot.externalSourceDescriptors === base.snapshot.externalSourceDescriptors
    ) {
      this.snapshotExternalDescriptorIndexes.set(committedSnapshot, priorDescriptorIndex);
    } else {
      this.snapshotExternalDescriptorIndexes.set(
        committedSnapshot,
        createSnapshotExternalDescriptorIndex(committedSnapshot.externalSourceDescriptors),
      );
    }

    const priorAnalysis = this.snapshotDependencyAnalysis.get(base.snapshot);
    const impactedOwnerPaths = new Set(changedOwnerPaths.values().flatMap((paths) => [...paths]));
    const incrementalDependencyKeys =
      priorAnalysis && !semanticMembershipChanged
        ? incrementalDependencyContributionKeys(
            priorAnalysis,
            impactedOwnerPaths,
            changedPaths,
            effects,
          )
        : null;
    if (priorAnalysis && incrementalDependencyKeys) {
      this.snapshotIncrementalDependencySeeds.set(committedSnapshot, {
        base: priorAnalysis,
        contributionKeys: incrementalDependencyKeys,
        symbolProjection: this.snapshotLuaSymbolProjections.get(base.snapshot),
      });
    } else if (!semanticMembershipChanged) {
      const dependencyReuse = this.snapshotDependencyReuse.get(base.snapshot);
      if (dependencyReuse)
        this.snapshotDependencyReuse.set(committedSnapshot, {
          // Without an analyzed graph there is no bounded way to identify the affected closure.
          // Drop semantic contributions rather than scanning them during mutation promotion.
          externalSourceRevisions: dependencyReuse.externalSourceRevisions,
        });
    }

    const coverageInputsChanged = effects.coverageInputsChanged;
    return withLazyOpenContent(
      {
        ok: true as const,
        snapshot: committedSnapshot,
        diagnostics: validation.diagnostics,
        editorState: committedSnapshot.project.editor,
        repairs: [],
        sourceContributions,
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
          fullProjectTraversals: incrementalSourceOwnership && !semanticMembershipChanged ? 0 : 1,
          fullProjectProjections: 0,
          foregroundSerializations: 0,
          foregroundSerializedBytes: 0,
          localizationCoverageInputsChanged: coverageInputsChanged,
          localizationCoverageDependencyRevision: coverageInputsChanged
            ? committedSnapshot.sourceRevision
            : base.sourceWork.localizationCoverageDependencyRevision,
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
            localizationCoverageDependencyRevision:
              `sha256:${'0'.repeat(64)}` as `sha256:${string}`,
          };
          let requiresFullSchemaParse = false;
          const reusableContribution = (relativePath: string) => {
            const contribution = reusableSourceContributions[relativePath];
            return contribution?.path === relativePath && contribution.schemaValid
              ? contribution
              : undefined;
          };
          const observedSourceRevisions = new Map<string, ProjectWorkspaceFileRevision>();
          const readSourceText = async (relativePath: string): Promise<string> => {
            const absolute = this.fileSystem.joinPath(discovered.projectRoot, relativePath);
            await this.assertContained(discovered.projectRoot, absolute);
            if (!this.fileSystem.readTextWithRevision) return this.fileSystem.readText(absolute);
            const observed = await this.fileSystem.readTextWithRevision(absolute);
            observedSourceRevisions.set(relativePath, observed.revision);
            return observed.text;
          };
          const readJsonSource = async (relativePath: string): Promise<unknown> => {
            admittedSourcePaths.add(relativePath);
            const contribution = reusableContribution(relativePath);
            if (contribution?.kind === 'json') {
              sourceWork.reusedJsonSources++;
              reusedJsonSourcePaths.add(relativePath);
              if (contribution.sourceText !== undefined)
                textSourceValues.set(relativePath, contribution.sourceText);
              const requiresMutableProjection =
                relativePath === 'project.yaml' ||
                /^records\/layouts\/[^/]+\/layout\.yaml$/u.test(relativePath) ||
                /^records\/scripts\/[^/]+\.yaml$/u.test(relativePath);
              return requiresMutableProjection
                ? structuredClone(contribution.parsed)
                : contribution.parsed;
            }
            sourceWork.authoredFilesReread++;
            sourceWork.parsedJsonSources++;
            freshJsonSourcePaths.add(relativePath);
            const text = await readSourceText(relativePath);
            if (relativePath.endsWith('.yaml')) textSourceValues.set(relativePath, text);
            return projectWorkspaceSourceCodec(relativePath).decode(text);
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
            const text = projectWorkspaceSourceCodec(relativePath).decode(
              await readSourceText(relativePath),
            ) as string;
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
          // Retired tracked JSON owners must invalidate admission even when the
          // corresponding YAML source exists. Unrelated machine JSON is not source.
          for (const file of [
            'project.json',
            'traits.json',
            'editor.json',
            'i18n/project.json',
            'i18n/messages.json',
            'i18n/usage-notes.json',
            'i18n/tracking.json',
            'i18n/orphans.json',
          ]) {
            if (
              (await this.fileSystem.inspect(
                this.fileSystem.joinPath(discovered.projectRoot, file),
              )) !== 'missing'
            )
              return fail(
                `Retired tracked JSON source '${file}' is not supported; use canonical .yaml Project files.`,
                `/${file}`,
              );
          }
          let manifest: Record<string, unknown>;
          try {
            await this.assertContained(discovered.projectRoot, discovered.manifestPath);
            const value = await readJsonSource('project.yaml');
            if (!value || typeof value !== 'object' || Array.isArray(value))
              return fail('project.yaml must be an object.');
            manifest = value as Record<string, unknown>;
          } catch {
            return fail(
              'Current project discovery requires a readable workspace-v1 project.yaml.',
              '/project.yaml',
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
            'inventories',
            'interactableInstances',
          ];
          const manifestKeys = Object.keys(manifest);
          if (
            manifestKeys.length < 8 ||
            manifestKeys.length > 10 ||
            !required.every((key) => key in manifest) ||
            manifestKeys.some(
              (key) =>
                ![
                  'schema',
                  'schemaVersion',
                  ...required,
                  'undefinedInteractionProgram',
                  'entrypoint',
                ].includes(key),
            )
          )
            return fail('project.yaml has an unsupported workspace-v1 shape.');
          if (freshJsonSourcePaths.has('project.yaml')) {
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
              this.fileSystem.joinPath(discovered.projectRoot, 'traits.yaml'),
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
              this.fileSystem.joinPath(discovered.projectRoot, 'editor.yaml'),
            );
            traits = await readJsonSource('traits.yaml');
            if (freshJsonSourcePaths.has('traits.yaml')) {
              const parsedTraits = traitsWorkspaceSchema.safeParse(traits);
              if (parsedTraits.success) traits = parsedTraits.data;
              else
                throw new Error(parsedTraits.error.issues.map((issue) => issue.message).join('; '));
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
                if (!entry.endsWith('.yaml'))
                  throw new Error(
                    `${directory} contains a non-YAML localization chunk '${entry}'.`,
                  );
                const locale = entry.slice(0, -5);
                if (!localeIdSchema.safeParse(locale).success)
                  throw new Error(`${directory} contains an invalid locale chunk '${entry}'.`);
                const absolute = this.fileSystem.joinPath(root, entry);
                await this.assertContained(discovered.projectRoot, absolute);
                if (target[locale] !== undefined)
                  throw new Error(`${directory} contains duplicate locale owners for '${locale}'.`);
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
            const value = await readJsonSource('editor.yaml');
            if (!value || typeof value !== 'object' || Array.isArray(value))
              return fail('editor.yaml must be an object.', '/editor.yaml');
            editor = value as Record<string, unknown>;
            if (Object.keys(editor).sort().join(',') !== 'chapters,recordMetadata,tags')
              return fail(
                'editor.yaml must contain exactly tracked organization fields.',
                '/editor.yaml',
              );
            trackedEditor = reusedJsonSourcePaths.has('editor.yaml')
              ? (editor as NonNullable<ReturnType<typeof parseTrackedEditorOrganization>>)
              : parseTrackedEditorOrganization(editor);
            if (!trackedEditor)
              return fail('editor.yaml tracked organization fields are malformed.', '/editor.yaml');
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
                if (
                  (await this.fileSystem.inspect(
                    this.fileSystem.joinPath(layoutPath, 'layout.json'),
                  )) !== 'missing'
                )
                  return fail(
                    'Retired Layout metadata layout.json is not supported; use layout.yaml.',
                    `/records/layouts/${entry}/layout.json`,
                  );
                const hasYaml =
                  (await this.fileSystem.inspect(
                    this.fileSystem.joinPath(layoutPath, 'layout.yaml'),
                  )) !== 'missing';
                if (!hasYaml)
                  return fail(
                    'Layout requires canonical layout.yaml metadata.',
                    `/records/layouts/${entry}`,
                  );
                const metadataName = 'layout.yaml';
                const relativeRecordPath = `records/layouts/${entry}/${metadataName}`;
                const file = this.fileSystem.joinPath(layoutPath, metadataName);
                let raw: Record<string, unknown>;
                try {
                  await this.assertContained(discovered.projectRoot, file);
                  raw = (await readJsonSource(relativeRecordPath)) as Record<string, unknown>;
                } catch {
                  return fail('Layout record is malformed.', `/${relativeRecordPath}`);
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
              if (!entry.endsWith('.yaml'))
                return fail(
                  'Record files must use canonical .yaml names.',
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
              if (collections[collection][id])
                return fail(
                  'Duplicate record identity across source files.',
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
              : await readWorkspaceFileRevision(
                  this.fileSystem,
                  discovered.projectRoot,
                  file,
                  observedSourceRevisions.get(file),
                );
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
          const admittedRawDescriptors = collectAuthoringLuaSources(decodedProject);
          const admittedExternalDescriptors = externalDescriptors(
            decodedProject,
            scriptSourcePaths,
            textSourceValues,
            undefined,
            admittedRawDescriptors,
          );
          const validationReuse: AuthoringValidationReuse = {
            contributions: options.reusableValidationContributions ?? [],
            luaSourceDescriptors: admittedRawDescriptors,
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
                  files.add('project.yaml');
                }
              }
              return [...files].sort(compareProjectWorkspaceUnicodeCodePoints).map((path) => ({
                path,
                contentHash: fileRevisions[path]!.contentHash,
              }));
            },
          };
          let admittedLocalizationSourceViews:
            | ReturnType<typeof localizationMessageSourceViews>
            | undefined;
          const validation = validateAdmittedAuthoringProject(
            decodedProject,
            validationReuse,
            'workspace',
            (views) => {
              admittedLocalizationSourceViews = views;
            },
          );
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
            if (projectWorkspaceSourceCodec(file).kind !== 'text') {
              let parsed: unknown;
              if (reused?.kind === 'json') parsed = reused.parsed;
              else {
                const recordMatch = /^records\/([^/]+)\/([^/]+)\.yaml$/u.exec(file);
                const collection = recordMatch?.[1];
                const recordId = recordMatch?.[2];
                if (
                  collection &&
                  recordId &&
                  isAuthoringCollectionKey(collection) &&
                  collection !== 'layouts' &&
                  collection !== 'scripts'
                )
                  parsed = decodedProject[collection][recordId];
                else {
                  sourceWork.projectedJsonSources++;
                  const normalizedText = projectWorkspaceFile(
                    decodedProject,
                    decodedProject.editor,
                    scriptSourcePaths,
                    file,
                  );
                  if (normalizedText === undefined)
                    return fail(
                      `Authoritative source file '${file}' was not projected.`,
                      `/${file}`,
                    );
                  const normalizedSource = projectWorkspaceSourceCodec(file).decode(
                    normalizedText,
                  ) as Record<string, unknown>;
                  // Hydration exposes Lua `none` as empty inline source, not an authored companion.
                  if (
                    /^records\/layouts\/[^/]+\/layout\.yaml$/u.test(file) &&
                    !admittedSourcePaths.has(file.replace(/\.yaml$/u, '.lua'))
                  )
                    (normalizedSource.data as Record<string, unknown>).lua = { sourceMode: 'none' };
                  parsed = normalizedSource;
                }
              }
              sourceContributions[file] = Object.freeze({
                path: file,
                contentHash: revision.contentHash,
                byteSize: revision.byteSize,
                kind: 'json' as const,
                parsed,
                ...(file.endsWith('.yaml') ? { sourceText: textSourceValues.get(file) } : {}),
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
          sourceWork.localizationCoverageDependencyRevision = workspaceRevision;
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
            externalSourceDescriptors: admittedExternalDescriptors,
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
          if (admittedLocalizationSourceViews)
            sharedSnapshotLocalizationSourceViews.set(snapshot, admittedLocalizationSourceViews);
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
    commentImpacts: readonly ProjectWorkspaceCommentImpact[];
    commentNotices: readonly ProjectWorkspaceCommentNotice[];
    deletedSourceTexts: Readonly<Record<string, string>>;
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
    const scriptSourcePathOverrideKeys = Object.keys(scriptSourcePathOverrides);
    const projectedSourcePaths =
      scriptSourcePathOverrideKeys.length === 0
        ? openedSnapshot.scriptSourcePaths
        : { ...openedSnapshot.scriptSourcePaths, ...scriptSourcePathOverrides };
    const sourceFiles = new Set(openedSnapshot.canonicalSourceFiles);
    const projectedOwnerFiles = new Set(sourceFiles);
    for (const { fromPath, toPath } of options.identityRemap ?? []) {
      const from = /^\/layouts\/([^/]+)$/u.exec(fromPath);
      const to = /^\/layouts\/([^/]+)$/u.exec(toPath);
      if (!from || !to) continue;
      const oldMetadata = recordFile('layouts', from[1]!);
      if (sourceFiles.has(oldMetadata))
        projectedOwnerFiles.add(
          oldMetadata.replace(`records/layouts/${from[1]!}/`, `records/layouts/${to[1]!}/`),
        );
      for (const channel of ['rml', 'rcss', 'lua'] as const)
        if (sourceFiles.has(layoutFile(from[1]!, channel)))
          projectedOwnerFiles.add(layoutFile(to[1]!, channel));
    }
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
      : projectWorkspaceFiles(project, editorState, projectedSourcePaths, projectedOwnerFiles);
    const priorFullProjection = explicitCandidates
      ? null
      : projectWorkspaceFiles(
          openedSnapshot.project,
          openedSnapshot.project.editor,
          openedSnapshot.scriptSourcePaths,
          sourceFiles,
        );
    const candidates = new Set(
      explicitCandidates ?? [...Object.keys(priorFullProjection!), ...Object.keys(fullProjection!)],
    );
    for (const file of Object.keys(options.sourceRestorations ?? {})) {
      if (!/^(?:records\/[^/]+\/[^/]+(?:\/layout)?|project|editor|traits)\.yaml$/u.test(file))
        throw new Error('Source restoration must name a canonical YAML owner.');
      candidates.add(file);
    }
    const sourceMoves = new Map<string, string>();
    for (const { fromPath, toPath } of options.identityRemap ?? []) {
      const from = /^\/([^/]+)\/([^/]+)$/u.exec(fromPath);
      const to = /^\/([^/]+)\/([^/]+)$/u.exec(toPath);
      if (!from || !to || from[1] !== to[1] || !isAuthoringCollectionKey(from[1]!))
        throw new Error('Invalid workspace record identity move.');
      const collection = from[1];
      if (
        !openedSnapshot.project[collection][from[2]!] ||
        openedSnapshot.project[collection][to[2]!] ||
        project[collection][from[2]!] ||
        !project[collection][to[2]!]
      )
        throw new Error(
          'Workspace identity move must remove an existing record and create a new identity.',
        );
      const oldFile = recordFile(collection, from[2]!);
      const newFile = recordFile(collection, to[2]!);
      if (sourceMoves.has(newFile) || [...sourceMoves.values()].includes(oldFile))
        throw new Error('Ambiguous workspace record identity move.');
      sourceMoves.set(newFile, oldFile);
      candidates.add(oldFile);
      candidates.add(newFile);
      if (collection === 'scripts') {
        const former = openedSnapshot.project.scripts[from[2]!]?.data.source;
        const latter = project.scripts[to[2]!]?.data.source;
        if (
          former?.kind === 'project-file' &&
          latter?.kind === 'project-file' &&
          former.path !== latter.path
        ) {
          if (sourceMoves.has(latter.path) || [...sourceMoves.values()].includes(former.path))
            throw new Error('Ambiguous Script Module Lua ownership move.');
          sourceMoves.set(latter.path, former.path);
          candidates.add(former.path);
          candidates.add(latter.path);
        }
      }
    }
    const expected =
      options.expectedFileRevisions ??
      (explicitCandidates
        ? Object.fromEntries(
            [...candidates].map((file) => [
              file,
              openedSnapshot.fileRevisions[file]?.contentHash ?? PROJECT_WORKSPACE_ABSENT_REVISION,
            ]),
          )
        : Object.fromEntries(
            Object.entries(openedSnapshot.fileRevisions).map(([file, revision]) => [
              file,
              revision.contentHash,
            ]),
          ));
    const targets: ProjectWorkspaceTransactionTargetInput[] = [];
    const commentImpacts: ProjectWorkspaceCommentImpact[] = [];
    const commentNotices: ProjectWorkspaceCommentNotice[] = [];
    const deletedSourceTexts: Record<string, string> = {};
    const nextSourceTexts = new Map<string, string>();
    let sourceMembershipChanged = false;
    for (const file of [...candidates].sort(compareProjectWorkspaceUnicodeCodePoints)) {
      const absolute = this.fileSystem.joinPath(projectRoot, file);
      const currentText = await (
        file.endsWith('.yaml')
          ? (this.fileSystem.readTextFresh?.(absolute) ?? this.fileSystem.readText(absolute))
          : this.fileSystem.readText(absolute)
      ).catch(() => null);
      const expectedRevision = expected[file] ?? PROJECT_WORKSPACE_ABSENT_REVISION;
      const actualRevision =
        currentText === null
          ? PROJECT_WORKSPACE_ABSENT_REVISION
          : await sha256PrefixedUtf8(currentText);
      // YAML source is read-and-edited as a document even when the semantic projection
      // would be unchanged. Non-YAML no-op candidates may legitimately be stale after
      // a separately admitted source-file operation; changed targets still use journal CAS.
      if (file.endsWith('.yaml') && actualRevision !== expectedRevision)
        throw new ProjectWorkspaceMutationError(
          'WORKSPACE_REVISION_CONFLICT',
          `Project source '${file}' changed outside the editor.`,
          file,
        );
      let priorText = sourceMoves.has(file)
        ? await this.fileSystem.readText(
            this.fileSystem.joinPath(projectRoot, sourceMoves.get(file)!),
          )
        : (currentText ?? options.sourceRestorations?.[file]);
      if (file === 'editor.yaml' && priorText !== undefined && options.identityRemap?.length)
        priorText = remapYamlRecordMetadata(priorText, options.identityRemap);
      let nextText =
        (file.endsWith('.yaml')
          ? projectWorkspaceFile(
              project,
              editorState,
              projectedSourcePaths,
              file,
              priorText,
              options.commentDisposition === 'keep',
              projectedOwnerFiles,
            )
          : fullProjection && !sourceMoves.has(file)
            ? fullProjection[file]
            : projectWorkspaceFile(
                project,
                editorState,
                projectedSourcePaths,
                file,
                undefined,
                false,
                projectedOwnerFiles,
              )) ?? null;
      // File-backed Script Modules own their Lua file without embedding it in the
      // record projection. Do not delete a still-owned source on metadata edits,
      // and carry its bytes when an explicit identity remap moves the Lua path.
      if (
        nextText === null &&
        Object.values(project.scripts).some(
          (record) =>
            record.data.source.kind === 'project-file' && record.data.source.path === file,
        )
      )
        nextText = sourceMoves.has(file) ? (priorText ?? null) : currentText;
      const restoration = options.sourceRestorations?.[file];
      if (
        file.endsWith('.yaml') &&
        currentText !== null &&
        nextText !== null &&
        restoration !== undefined
      ) {
        nextText =
          projectWorkspaceFile(
            project,
            editorState,
            projectedSourcePaths,
            file,
            restoreMissingYamlSource(currentText, nextText, restoration),
            options.commentDisposition === 'keep',
            projectedOwnerFiles,
          ) ?? null;
      }
      sourceMembershipChanged ||=
        (openedSnapshot.fileRevisions[file] !== undefined) !== (nextText !== null);
      if (nextText !== null) nextSourceTexts.set(file, nextText);
      if (currentText === nextText) continue;
      if (file.endsWith('.yaml') && priorText !== undefined) {
        const movedAway = [...sourceMoves.values()].includes(file);
        if (!movedAway) {
          const impacts = yamlCommentImpacts(priorText, nextText ?? undefined)
            .filter(
              (impact) =>
                !(sourceMoves.has(file) && impact.path === '/id' && impact.kind === 'changed'),
            )
            .map((impact) => {
              // A sparse authored field can disappear from YAML while its effective
              // value still exists as a declared default. This is a change, not an
              // element deletion, so Keep must remain an available decision.
              const match = /^records\/([^/]+)\/([^/]+)\.yaml$/u.exec(file);
              const layout = /^records\/layouts\/([^/]+)\/layout\.yaml$/u.exec(file);
              let effective: unknown = layout
                ? project.layouts[layout[1]!]
                : match && isAuthoringCollectionKey(match[1]!)
                  ? project[match[1] as AuthoringCollectionKey][match[2]!]
                  : file === 'project.yaml'
                    ? project
                    : file === 'editor.yaml'
                      ? editorState
                      : file === 'traits.yaml'
                        ? project.traits
                        : undefined;
              let previousEffective: unknown = layout
                ? openedSnapshot.project.layouts[layout[1]!]
                : match && isAuthoringCollectionKey(match[1]!)
                  ? openedSnapshot.project[match[1] as AuthoringCollectionKey][match[2]!]
                  : file === 'project.yaml'
                    ? openedSnapshot.project
                    : file === 'editor.yaml'
                      ? openedSnapshot.project.editor
                      : file === 'traits.yaml'
                        ? openedSnapshot.project.traits
                        : undefined;
              if (impact.kind === 'deleted' && nextText !== null && effective !== undefined) {
                for (const segment of impact.path.split('/').slice(1)) {
                  const key = segment.replace(/~1/gu, '/').replace(/~0/gu, '~');
                  if (Array.isArray(previousEffective) && Array.isArray(effective)) {
                    const prior = previousEffective[Number(key)] as { id?: unknown } | undefined;
                    const stableId = prior && typeof prior.id === 'string' ? prior.id : undefined;
                    effective = stableId
                      ? effective.find(
                          (item) => item && typeof item === 'object' && item.id === stableId,
                        )
                      : effective[Number(key)];
                    previousEffective = prior;
                  } else {
                    previousEffective =
                      previousEffective && typeof previousEffective === 'object'
                        ? (previousEffective as Record<string, unknown>)[key]
                        : undefined;
                    effective =
                      effective && typeof effective === 'object'
                        ? (effective as Record<string, unknown>)[key]
                        : undefined;
                  }
                  if (effective === undefined) break;
                }
              }
              return {
                file,
                ...impact,
                kind:
                  impact.kind === 'deleted' && nextText !== null && effective !== undefined
                    ? ('changed' as const)
                    : impact.kind,
              };
            });
          commentImpacts.push(...impacts);
          if (nextText === null || impacts.some((impact) => impact.kind === 'deleted'))
            deletedSourceTexts[file] = priorText;
          if (
            (options.commentDisposition === 'remove' || options.commentDisposition === 'delete') &&
            nextText !== null
          ) {
            nextText = removeChangedYamlComments(nextText, impacts);
            nextSourceTexts.set(file, nextText);
          }
        }
      }
      targets.push(
        nextText === null
          ? { path: file, operation: 'delete', expectedRevision }
          : utf8WorkspaceTransactionTarget(file, expectedRevision, nextText),
      );
    }
    if (options.identityRemap?.length) {
      const finalFiles = new Set(openedSnapshot.canonicalSourceFiles);
      for (const target of targets) {
        if (target.operation === 'delete') finalFiles.delete(target.path);
        else if (target.path.endsWith('.yaml')) finalFiles.add(target.path);
      }
      for (const file of [...finalFiles].filter((name) => name.endsWith('.yaml')).sort()) {
        const text =
          nextSourceTexts.get(file) ??
          (await this.fileSystem
            .readText(this.fileSystem.joinPath(projectRoot, file))
            .catch(() => ''));
        for (const identity of options.identityRemap) {
          const oldId = identity.fromPath.split('/')[2];
          if (!oldId) continue;
          for (const mention of yamlCommentTokenMentions(text, oldId))
            commentNotices.push({ file, oldId, ...mention });
        }
      }
    }
    targets.push(...(options.extraTargets ?? []));
    if (options.dryRun)
      return withLazyWriteContent(
        {
          workspaceRevision: openedSnapshot.workspaceRevision,
          snapshot: openedSnapshot,
          commentImpacts,
          commentNotices,
          deletedSourceTexts,
        },
        project,
      );
    let projectedSnapshot: LoadedProjectWorkspaceSnapshot | null = null;
    if (options.refreshAfterCommit === false) {
      // A resident generation must own a stable authoring value. Mutation callers intentionally
      // keep editing their mutable Project object after a save; retaining that same object here
      // would retroactively mutate the coherent "before" generation and hide later removals.
      const committedProject = cloneAuthoringProject(project);
      const incrementalProjection =
        explicitCandidates !== null &&
        !sourceMembershipChanged &&
        scriptSourcePathOverrideKeys.length === 0;
      let canonicalSourceFiles: readonly string[];
      let fileRevisions: Readonly<Record<string, ProjectWorkspaceFileRevision>>;
      const revisionChanges: Record<string, ProjectWorkspaceFileRevision> = {};
      let canonicalSourceFileSet: Set<string> | null = null;
      if (incrementalProjection) {
        canonicalSourceFiles = openedSnapshot.canonicalSourceFiles;
      } else {
        canonicalSourceFileSet = new Set(openedSnapshot.canonicalSourceFiles);
        for (const file of candidates) {
          const nextText = nextSourceTexts.get(file);
          if (nextText === undefined) canonicalSourceFileSet.delete(file);
          else canonicalSourceFileSet.add(file);
        }
        canonicalSourceFiles = [...canonicalSourceFileSet].sort(
          compareProjectWorkspaceUnicodeCodePoints,
        );
      }
      for (const target of targets) {
        const isCanonical = incrementalProjection
          ? openedSnapshot.fileRevisions[target.path] !== undefined
          : canonicalSourceFileSet!.has(target.path);
        if (!isCanonical) continue;
        if (target.operation === 'delete') {
          continue;
        }
        const bytes = target.bytes!;
        revisionChanges[target.path] = {
          contentHash: await sha256PrefixedBytes(bytes),
          byteSize: bytes.byteLength,
        };
      }
      if (incrementalProjection) {
        fileRevisions = overlayRecord(openedSnapshot.fileRevisions, revisionChanges);
      } else {
        const rebuiltRevisions: Record<string, ProjectWorkspaceFileRevision> = {
          ...openedSnapshot.fileRevisions,
          ...revisionChanges,
        };
        for (const file of Object.keys(rebuiltRevisions))
          if (!canonicalSourceFileSet!.has(file)) delete rebuiltRevisions[file];
        fileRevisions = rebuiltRevisions;
      }
      for (const file of canonicalSourceFiles)
        if (!fileRevisions[file])
          throw new Error(`Committed workspace omitted revision state for '${file}'.`);
      const priorRevisionState = snapshotRevisionStates.get(openedSnapshot);
      const aggregate =
        incrementalProjection && priorRevisionState
          ? await advanceRevisionState(
              priorRevisionState,
              openedSnapshot.fileRevisions,
              fileRevisions,
              Object.keys(revisionChanges),
            )
          : await aggregateRevisionState(fileRevisions);
      const workspaceRevision = aggregate.revision;
      const descriptorAdvance = incrementalProjection
        ? this.advanceExternalDescriptors(openedSnapshot, committedProject, projectedSourcePaths, [
            ...candidates,
          ])
        : null;
      projectedSnapshot = Object.freeze({
        snapshotKind: 'loaded',
        projectRoot: openedSnapshot.projectRoot,
        manifestPath: openedSnapshot.manifestPath,
        project: committedProject,
        workspaceRevision,
        sourceRevision: workspaceRevision,
        canonicalSourceFiles,
        fileRevisions,
        saveUnitFileOwnership: incrementalProjection
          ? openedSnapshot.saveUnitFileOwnership
          : ownershipFor(committedProject, projectedSourcePaths),
        externalSourceDescriptors:
          descriptorAdvance?.descriptors ??
          externalDescriptors(committedProject, projectedSourcePaths),
        scriptSourcePaths: incrementalProjection
          ? openedSnapshot.scriptSourcePaths
          : Object.freeze(sortKeys(projectedSourcePaths)),
      });
      committedSourceTexts.set(projectedSnapshot, nextSourceTexts);
      snapshotRevisionStates.set(projectedSnapshot, aggregate.state);
      if (descriptorAdvance)
        this.snapshotExternalDescriptorIndexes.set(projectedSnapshot, descriptorAdvance.index);
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
          commentImpacts,
          commentNotices,
          deletedSourceTexts,
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
      commentImpacts,
      commentNotices,
      deletedSourceTexts,
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
  /** Authoring diagnostics already computed for this admitted immutable snapshot. */
  admittedAuthoringDiagnostics(
    snapshot: ProjectWorkspaceSnapshot,
  ): readonly ProjectValidationDiagnostic[] | null {
    return this.snapshotValidators.get(snapshot)?.(snapshot.project) ?? null;
  }
  admittedValidationContributions(
    snapshot: ProjectWorkspaceSnapshot,
  ): readonly AuthoringValidationContribution[] | null {
    const state = this.snapshotValidationStates.get(snapshot);
    return state ? [...state.byKey.values()] : null;
  }
  /** Native Project owners can publish an exact-generation runtime Asset reference closure. */
  admittedRuntimeAssetReferences(_snapshot: ProjectWorkspaceSnapshot): readonly string[] | null {
    return null;
  }
  localizationSourceViews(
    snapshot: ProjectWorkspaceSnapshot,
  ): ReturnType<typeof localizationMessageSourceViews> {
    let views = sharedSnapshotLocalizationSourceViews.get(snapshot);
    if (!views) {
      views = localizationMessageSourceViews(snapshot.project);
      sharedSnapshotLocalizationSourceViews.set(snapshot, views);
    }
    return views;
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
      if (incrementalSeed.contributionKeys.size === 0) {
        // A new physical workspace revision need not rebuild the immutable graph
        // when the dependency planner identified no changed graph inputs.
        const base = incrementalSeed.base;
        const result: ProjectWorkspaceDependencyAnalysis = {
          ...base,
          work: {
            derivedContributions: 0,
            reusedContributions: base.contributions.byKey.size,
            analyzedOwners: 0,
            reusedSourceAnalyses: base.sourceAnalyses.size,
            fullProjectTraversals: 0,
          },
        };
        this.snapshotDependencyAnalysis.set(snapshot, result);
        if (incrementalSeed.symbolProjection)
          this.snapshotLuaSymbolProjections.set(snapshot, incrementalSeed.symbolProjection);
        return result;
      }
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
        for (const descriptor of descriptorsByKey.get(key) ?? []) {
          if (descriptor.sourceUrl.startsWith('project:/'))
            paths.add(descriptor.sourceUrl.slice('project:/'.length));
          for (const path of descriptor.dependencyScriptPaths ?? []) paths.add(path);
        }
        sourcePathChanges.set(
          key,
          Object.freeze([...paths].sort(compareProjectWorkspaceUnicodeCodePoints)),
        );
      }

      const analysisChanges = new Map<
        string,
        readonly AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[]
      >();
      const workflowMessages = [...changedKeys].some((key) =>
        key.startsWith('localization-message:'),
      )
        ? new Map(this.localizationSourceViews(snapshot).map((message) => [message.id, message]))
        : undefined;
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
          workflowMessages,
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
        // A source may be rechecked but produce no revision (missing file,
        // declared hash mismatch, unreadable bytes, etc.). Reusing the old
        // revision in that case would falsely prove the partial graph complete
        // to runtime artifact preparation. Preserve evidence for untouched
        // sources, but revoke it for failed revalidations.
        const unavailablePaths = failedWorkspaceSourceProofs(snapshot.project, sourceSnapshot);
        const externalSourceRevisions = overlayReadonlyMap(
          incrementalSeed.base.externalSourceRevisions,
          sourceSnapshot.externalSourceRevisions,
          unavailablePaths,
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
      for (const path of descriptor.dependencyScriptPaths ?? []) {
        const paths = sourcePathsByContributionKey.get(descriptor.contributionKey) ?? new Set();
        paths.add(path);
        sourcePathsByContributionKey.set(descriptor.contributionKey, paths);
      }
    }
    const symbolProjection = buildAuthoringLuaSymbolProjection(snapshot.project);
    const workflowMessages =
      missingKeys.size && [...missingKeys].some((key) => key.startsWith('localization-message:'))
        ? new Map(this.localizationSourceViews(snapshot).map((message) => [message.id, message]))
        : undefined;
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
        workflowMessages,
      );
      if (!contribution)
        throw new Error(`Unable to derive graph contribution '${contributionKey}'.`);
      derived.push(contribution);
      return contribution;
    });
    const contributions = createAuthoringDependencyGraphContributionSet(allContributions);
    const externalSourceRevisions = new Map(reusable?.externalSourceRevisions ?? []);
    for (const path of failedWorkspaceSourceProofs(snapshot.project, sourceSnapshot))
      externalSourceRevisions.delete(path);
    for (const [path, revision] of sourceSnapshot.externalSourceRevisions)
      externalSourceRevisions.set(path, revision);
    this.snapshotDependencyReuse.set(snapshot, {
      contributions: Object.freeze([...contributions.byKey.values()]),
      sourceAnalyses: analyses,
      externalSourceRevisions,
    });
    const graph = assembleAuthoringDependencyGraph(contributions);
    const result: ProjectWorkspaceDependencyAnalysis = {
      graph,
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
