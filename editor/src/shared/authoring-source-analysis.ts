import type {
  AuthoringDependencyContributionKey,
  AuthoringDependencyGraphDiagnostic,
  AuthoringDependencyNodeKey,
} from './authoring-dependency-contracts';
import { buildJsonPointer, escapeJsonPointerSegment, parseJsonPointer } from './json-pointer';
import {
  AUTHORING_SOURCE_ANALYZER_VERSION,
  LUA_REFERENCE_ANALYSIS_LIMITS,
  type AuthoringCursorNameOccurrence,
  type AuthoringLiteralOccurrence,
  type AuthoringSourceAnalysisArtifact,
  type AuthoringSourceContentArtifact,
  type EmbeddedLuaSourceRegion,
  type LuaSourceSnapshot,
  type OwnerNeutralEmbeddedLuaSourceRegion,
  type OwnerNeutralLiteralOccurrence,
  type OwnerNeutralManagedLuaMessageOccurrence,
  type OwnerNeutralSourceDiagnostic,
} from './project-schema/authoring-lua-analysis';
import type { AuthoringProject } from './project-schema/authoring-project';
import {
  authoringCollectionKeys,
  type AuthoringCollectionKey,
} from './project-schema/authoring-collections';
import { parseLayoutData } from './project-schema/authoring-layouts';
import { parseScriptModuleData } from './project-schema/authoring-script-modules';
import { parseRoomData } from './project-schema/authoring-rooms';
import { parseSceneData } from './project-schema/authoring-scenes';
import { parseDialogueData } from './project-schema/authoring-dialogues';
import { parseVerbData } from './project-schema/authoring-verbs';
import { parseInteractionData } from './project-schema/authoring-interactions';
import { parseMapData } from './project-schema/authoring-maps';
import { parseTestData } from './project-schema/authoring-tests';
import {
  collectRegisteredAuthoringLuaSources,
  isRegisteredLuaExplicitFallbackOwner,
  type AuthoringLuaExecutionSurface,
  type RegisteredAuthoringLuaSource,
} from './project-schema/authoring-lua-source-registry';
import {
  authoringAssetPath as assetPath,
  declaredLayoutDependencyByResolvedPath,
  resolveLayoutProjectUri,
} from './layout-source-resolution';
import { inlineLayoutSourceUrl } from './project-schema/layout-source-url';

import {
  utf8,
  sha256,
  lexLuaStringLiterals,
  extractRmlRegions,
  analyzeManagedLuaLocalization,
  nestedStringRegions,
  scanRcssCursorNames,
  scanRmlCursorNames,
  extractRmlExternalReferences,
  extractTemplateNames,
} from './authoring-source-downstream';
export * from './authoring-source-downstream';

export type AuthoringLuaSourceDescriptor = {
  executionSurface: AuthoringLuaExecutionSurface;
  contributionKey: AuthoringDependencyContributionKey;
  semanticOwner: AuthoringDependencyNodeKey;
  sourcePath: string;
  sourceKind: 'lua' | 'rml' | 'rcss';
  sourceUrl: string;
  inlineText?: string;
  sourceAssetId?: string;
  focusedAdmission: boolean;
  focusedFacet?: 'preview-visual' | 'preview-ui';
  supportsExplicitFallback: boolean;
  explicitDependenciesPath?: string;
  explicitDependencies?: readonly unknown[];
  layoutId?: string;
  dependencyScriptPaths?: readonly string[];
  dependencyTemplateIds?: readonly string[];
};

export interface AuthoringSourceAnalysisCache {
  contentArtifacts: Map<string, AuthoringSourceContentArtifact>;
  ownerProjections: Map<
    string,
    AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>
  >;
}

export function createAuthoringSourceAnalysisCache(): AuthoringSourceAnalysisCache {
  return { contentArtifacts: new Map(), ownerProjections: new Map() };
}

export const recordKey = (
  collection: AuthoringCollectionKey,
  id: string,
): AuthoringDependencyNodeKey => ({
  kind: 'record',
  collection,
  id,
});
const recordContributionKey = (collection: AuthoringCollectionKey, id: string) =>
  `record:${JSON.stringify(['record', collection, id])}`;

const schemaParsers = {
  rooms: parseRoomData,
  scenes: parseSceneData,
  dialogues: parseDialogueData,
  verbs: parseVerbData,
  interactions: parseInteractionData,
  maps: parseMapData,
  tests: parseTestData,
} as const;

function sourceDescriptorFromScript(
  project: AuthoringProject,
  scriptId: string,
  owner: AuthoringDependencyNodeKey,
  contributionKey: string,
  sourcePath: string,
  ownerBasePath: readonly string[],
  registered: RegisteredAuthoringLuaSource,
): AuthoringLuaSourceDescriptor | null {
  const parsed = parseScriptModuleData(project.scripts[scriptId]?.data);
  if (!parsed) return null;
  return {
    executionSurface: registered.surface,
    contributionKey,
    semanticOwner: owner,
    sourcePath,
    sourceKind: 'lua',
    sourceUrl:
      parsed.source.kind === 'inline-lua'
        ? 'authoring:inline-lua'
        : `project:/${parsed.source.path}`,
    inlineText: parsed.source.kind === 'inline-lua' ? parsed.source.source : undefined,
    focusedAdmission: registered.focusedAdmission,
    focusedFacet: registered.focusedFacet,
    supportsExplicitFallback: registered.supportsExplicitFallback,
    explicitDependenciesPath: registered.explicitDependenciesPath
      ? buildJsonPointer([...ownerBasePath, ...registered.explicitDependenciesPath])
      : undefined,
    explicitDependencies: registered.explicitDependencies,
  };
}

export function collectAuthoringLuaSources(
  project: AuthoringProject,
  contributionKeys?: ReadonlySet<AuthoringDependencyContributionKey>,
): readonly AuthoringLuaSourceDescriptor[] {
  const output: AuthoringLuaSourceDescriptor[] = [];
  const appendScript = (id: string) => {
    const record = project.scripts[id];
    if (!record) return;
    const contributionKey = recordContributionKey('scripts', id);
    const parsed = parseScriptModuleData(record.data);
    if (!parsed) return;
    const base = `/scripts/${escapeJsonPointerSegment(id)}/data/source`;
    output.push({
      executionSurface: 'script-record',
      contributionKey,
      semanticOwner: recordKey('scripts', id),
      sourcePath: parsed.source.kind === 'inline-lua' ? `${base}/source` : `${base}/path`,
      sourceKind: 'lua',
      sourceUrl:
        parsed.source.kind === 'inline-lua'
          ? 'authoring:inline-lua'
          : `project:/${parsed.source.path}`,
      inlineText: parsed.source.kind === 'inline-lua' ? parsed.source.source : undefined,
      focusedAdmission: false,
      supportsExplicitFallback: false,
    });
  };
  const appendLayout = (id: string) => {
    const record = project.layouts[id];
    if (!record) return;
    const contributionKey = recordContributionKey('layouts', id);
    const parsed = parseLayoutData(record.data);
    if (!parsed) return;
    const owner = recordKey('layouts', id);
    for (const [name, sourceKind] of [
      ['lua', 'lua'],
      ['rml', 'rml'],
      ['rcss', 'rcss'],
    ] as const) {
      const source = parsed[name];
      const base = `/layouts/${escapeJsonPointerSegment(id)}/data/${name}`;
      const sourceAssetId = source.sourceMode === 'asset' ? source.sourceAsset?.$ref.id : undefined;
      const sourceAssetPath = sourceAssetId ? assetPath(project, sourceAssetId) : null;
      output.push({
        executionSurface: name === 'lua' ? 'layout-dedicated-lua' : 'layout-rml',
        contributionKey,
        semanticOwner: owner,
        sourcePath:
          source.sourceMode === 'inline' ? `${base}/sourceText` : `${base}/sourceAsset/$ref`,
        sourceKind,
        sourceUrl:
          source.sourceMode === 'inline'
            ? sourceKind === 'rml'
              ? inlineLayoutSourceUrl(id)
              : sourceKind === 'rcss'
                ? 'authoring:inline-rcss'
                : 'authoring:inline-lua'
            : sourceAssetPath
              ? `project:/${sourceAssetPath}`
              : sourceKind === 'rml'
                ? 'project:/__missing_layout.rml'
                : sourceKind === 'rcss'
                  ? 'project:/__missing_layout.rcss'
                  : 'project:/__missing_layout.lua',
        inlineText: source.sourceMode === 'inline' ? source.sourceText : undefined,
        sourceAssetId,
        focusedAdmission: name === 'rml' || (name === 'lua' && parsed.script.enabled),
        focusedFacet: 'preview-ui',
        supportsExplicitFallback:
          name === 'rml' && isRegisteredLuaExplicitFallbackOwner(['layouts', id, 'data', 'script']),
        explicitDependenciesPath:
          name === 'rml'
            ? `/layouts/${escapeJsonPointerSegment(id)}/data/script/additionalDependencies`
            : undefined,
        explicitDependencies:
          name === 'rml' ? parsed.script.additionalDependencies?.targets : undefined,
        layoutId: id,
        dependencyScriptPaths: parsed.dependencies.scripts,
        dependencyTemplateIds: (parsed.dependencies.templates ?? []).map((ref) => ref.$ref.id),
      });
    }
  };
  const appendRegistered = (collection: keyof typeof schemaParsers, id: string) => {
    const record = project[collection][id];
    if (!record) return;
    const contributionKey = recordContributionKey(collection, id);
    const parsed = schemaParsers[collection](record.data) as unknown;
    if (!parsed) return;
    const baseSegments = [collection, id, 'data'];
    const owner = recordKey(collection, id);
    for (const registered of collectRegisteredAuthoringLuaSources(collection, parsed)) {
      const absoluteSourcePath = buildJsonPointer([...baseSegments, ...registered.sourcePath]);
      if (registered.scriptRecordId) {
        const descriptor = sourceDescriptorFromScript(
          project,
          registered.scriptRecordId,
          owner,
          contributionKey,
          absoluteSourcePath,
          baseSegments,
          registered,
        );
        if (descriptor) output.push(descriptor);
        continue;
      }
      output.push({
        executionSurface: registered.surface,
        contributionKey,
        semanticOwner: owner,
        sourcePath: absoluteSourcePath,
        sourceKind: 'lua',
        sourceUrl: 'authoring:inline-lua',
        inlineText: registered.sourceText,
        focusedAdmission: registered.focusedAdmission,
        focusedFacet: registered.focusedFacet,
        supportsExplicitFallback: registered.supportsExplicitFallback,
        explicitDependenciesPath: registered.explicitDependenciesPath
          ? buildJsonPointer([...baseSegments, ...registered.explicitDependenciesPath])
          : undefined,
        explicitDependencies: registered.explicitDependencies,
      });
    }
  };

  if (contributionKeys) {
    const selected: Array<readonly [AuthoringCollectionKey, string]> = [];
    const collectionKeys = new Set<string>(authoringCollectionKeys);
    for (const key of contributionKeys) {
      if (!key.startsWith('record:')) continue;
      try {
        const parsed = JSON.parse(key.slice('record:'.length)) as unknown;
        if (
          !Array.isArray(parsed) ||
          parsed.length !== 3 ||
          parsed[0] !== 'record' ||
          typeof parsed[1] !== 'string' ||
          !collectionKeys.has(parsed[1]) ||
          typeof parsed[2] !== 'string'
        )
          continue;
        selected.push([parsed[1] as AuthoringCollectionKey, parsed[2]]);
      } catch {
        continue;
      }
    }
    selected.sort(
      ([leftCollection, leftId], [rightCollection, rightId]) =>
        leftCollection.localeCompare(rightCollection) || leftId.localeCompare(rightId),
    );
    for (const [collection, id] of selected) {
      if (collection === 'scripts') appendScript(id);
      else if (collection === 'layouts') appendLayout(id);
      else if (collection in schemaParsers)
        appendRegistered(collection as keyof typeof schemaParsers, id);
    }
  } else {
    for (const id of Object.keys(project.scripts).sort()) appendScript(id);
    for (const id of Object.keys(project.layouts).sort()) appendLayout(id);
    for (const collection of Object.keys(schemaParsers) as (keyof typeof schemaParsers)[])
      for (const id of Object.keys(project[collection]).sort()) appendRegistered(collection, id);
  }
  return Object.freeze(
    output.sort(
      (a, b) =>
        a.contributionKey.localeCompare(b.contributionKey) ||
        a.sourcePath.localeCompare(b.sourcePath),
    ),
  );
}

export function classifyAuthoringLuaSourceOwner(
  project: AuthoringProject,
  sourcePath: string,
): AuthoringLuaSourceDescriptor | null {
  return (
    collectAuthoringLuaSources(project).find((source) => source.sourcePath === sourcePath) ?? null
  );
}

export async function analyzeAuthoringSourceContent(input: {
  sourceUrl: string;
  text: string;
  kind: 'lua' | 'rml' | 'rcss';
  contentHash?: `sha256:${string}`;
  limits?: {
    maxSourceBytes: number;
    maxEmbeddedListenerDepth: number;
  };
}): Promise<AuthoringSourceContentArtifact> {
  const contentHash = input.contentHash ?? (await sha256(input.text));
  const limits = input.limits ?? LUA_REFERENCE_ANALYSIS_LIMITS;
  const fingerprint = await sha256(
    JSON.stringify([AUTHORING_SOURCE_ANALYZER_VERSION, input.kind, input.sourceUrl, contentHash]),
  );
  if (utf8.encode(input.text).byteLength > limits.maxSourceBytes)
    return {
      analyzerVersion: AUTHORING_SOURCE_ANALYZER_VERSION,
      sourceContentFingerprint: fingerprint,
      regions: [],
      literalOccurrences: [],
      cursorNameOccurrences: [],
      managedMessageOccurrences: [],
      diagnostics: [
        {
          code: 'authoring.lua.source_limit',
          severity: 'warning',
          message: 'Source exceeds the fixed analysis byte limit.',
          sourceUrl: input.sourceUrl,
        },
      ],
      complete: false,
    };
  const extracted =
    input.kind === 'rml'
      ? extractRmlRegions(input.text, input.sourceUrl)
      : input.kind === 'lua'
        ? {
            regions: [
              {
                kind: 'lua-field' as const,
                text: input.text,
                line: 1,
                column: 1,
                sourceUrl: input.sourceUrl,
                embeddedDepth: 0,
              },
            ],
            diagnostics: [],
            complete: true,
          }
        : { regions: [], diagnostics: [], complete: true };
  const rawRegions = [...extracted.regions];
  for (let index = 0; index < rawRegions.length; index += 1) {
    const region = rawRegions[index];
    if (region.embeddedDepth >= limits.maxEmbeddedListenerDepth) continue;
    rawRegions.push(...nestedStringRegions(region, index));
  }
  const regions: OwnerNeutralEmbeddedLuaSourceRegion[] = [];
  const literals: OwnerNeutralLiteralOccurrence[] = [];
  const managedMessages: OwnerNeutralManagedLuaMessageOccurrence[] = [];
  const cursorNameOccurrences =
    input.kind === 'rml'
      ? scanRmlCursorNames(input.text, input.sourceUrl, contentHash)
      : input.kind === 'rcss'
        ? scanRcssCursorNames(input.text, input.sourceUrl, contentHash)
        : [];
  let complete = extracted.complete;
  const diagnostics: OwnerNeutralSourceDiagnostic[] = extracted.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    sourceUrl: input.sourceUrl,
  }));
  rawRegions.forEach((region, regionOrdinal) => {
    regions.push({
      sourceUrl: region.sourceUrl,
      sourceKind: region.kind,
      containerContentHash: contentHash,
      regionOrdinal,
      parentRegionOrdinal: region.parentRegionOrdinal,
      containerLine: region.line,
      containerColumn: region.column,
      decodedSource: region.text,
    });
    const lexed = lexLuaStringLiterals(region.text);
    complete &&= lexed.complete;
    if (!lexed.complete)
      diagnostics.push({
        code: 'authoring.lua.lexical_incomplete',
        severity: 'warning',
        message: 'Lua source contains an unterminated or unsupported lexical construct.',
        sourceUrl: input.sourceUrl,
        regionOrdinal,
        line: region.line,
        column: region.column,
      });
    for (const literal of lexed.literals)
      literals.push({
        ...literal,
        line: region.line + literal.line - 1,
        column: literal.line === 1 ? region.column + literal.column - 1 : literal.column,
        sourceUrl: region.sourceUrl,
        sourceContentHash: contentHash,
        regionOrdinal,
        sourceKind: region.kind,
      });
    const managed = analyzeManagedLuaLocalization(region.text);
    for (const diagnostic of managed.diagnostics)
      diagnostics.push({
        code: diagnostic.code,
        severity: 'error',
        message: diagnostic.message,
        sourceUrl: region.sourceUrl,
        regionOrdinal,
        line: region.line + diagnostic.line - 1,
        column: diagnostic.line === 1 ? region.column + diagnostic.column - 1 : diagnostic.column,
      });
    for (const occurrence of managed.occurrences) {
      const literal = occurrence.sourceLiteral;
      managedMessages.push({
        ...occurrence,
        line: region.line + occurrence.line - 1,
        column: occurrence.line === 1 ? region.column + occurrence.column - 1 : occurrence.column,
        sourceUrl: region.sourceUrl,
        sourceContentHash: contentHash,
        regionOrdinal,
        sourceLiteral: {
          ...literal,
          line: region.line + literal.line - 1,
          column: literal.line === 1 ? region.column + literal.column - 1 : literal.column,
          sourceUrl: region.sourceUrl,
          sourceContentHash: contentHash,
          regionOrdinal,
          sourceKind: region.kind,
        },
      });
    }
  });
  return {
    analyzerVersion: AUTHORING_SOURCE_ANALYZER_VERSION,
    sourceContentFingerprint: fingerprint,
    regions: Object.freeze(regions),
    literalOccurrences: Object.freeze(literals),
    cursorNameOccurrences: Object.freeze(cursorNameOccurrences),
    managedMessageOccurrences: Object.freeze(managedMessages),
    diagnostics: Object.freeze(diagnostics),
    complete,
  };
}

export async function bindAuthoringSourceOwner(
  descriptor: AuthoringLuaSourceDescriptor,
  artifacts: readonly AuthoringSourceContentArtifact[],
): Promise<AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>> {
  const regions: EmbeddedLuaSourceRegion[] = [];
  const literals: AuthoringLiteralOccurrence[] = [];
  const managedMessages: import('./project-schema/authoring-lua-analysis').AuthoringManagedLuaMessageOccurrence[] =
    [];
  const cursorNameOccurrences: AuthoringCursorNameOccurrence[] = [];
  const diagnostics: AuthoringDependencyGraphDiagnostic[] = [];
  for (const artifact of artifacts) {
    regions.push(
      ...artifact.regions.map((region) => ({
        ...region,
        semanticOwner: descriptor.semanticOwner,
        sourcePath: descriptor.sourcePath,
        sourceAssetId: descriptor.sourceAssetId,
      })),
    );
    literals.push(
      ...artifact.literalOccurrences.map((literal) => ({
        ...literal,
        sourcePath: descriptor.sourcePath,
        sourceAssetId: descriptor.sourceAssetId,
      })),
    );
    cursorNameOccurrences.push(
      ...artifact.cursorNameOccurrences.map((occurrence) => ({
        ...occurrence,
        sourcePath: descriptor.sourcePath,
        sourceAssetId: descriptor.sourceAssetId,
      })),
    );
    managedMessages.push(
      ...artifact.managedMessageOccurrences.map((occurrence) => ({
        ...occurrence,
        sourcePath: descriptor.sourcePath,
        sourceAssetId: descriptor.sourceAssetId,
        sourceLiteral: {
          ...occurrence.sourceLiteral,
          sourcePath: descriptor.sourcePath,
          sourceAssetId: descriptor.sourceAssetId,
        },
      })),
    );
    diagnostics.push(
      ...artifact.diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        code: diagnostic.code,
        path: descriptor.sourcePath,
        message: diagnostic.message,
        sourceUrl: diagnostic.sourceUrl,
        ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
        ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
      })),
    );
  }
  return {
    semanticOwnerKey: descriptor.contributionKey,
    analyzerVersion: AUTHORING_SOURCE_ANALYZER_VERSION,
    sourceContentFingerprints: artifacts.map((artifact) => artifact.sourceContentFingerprint),
    ownerProjectionFingerprint: await sha256(
      JSON.stringify([
        AUTHORING_SOURCE_ANALYZER_VERSION,
        descriptor.executionSurface,
        descriptor.contributionKey,
        descriptor.sourcePath,
        descriptor.sourceUrl,
        descriptor.sourceAssetId ?? null,
        artifacts.map((artifact) => artifact.sourceContentFingerprint),
      ]),
    ),
    sourceAssetIds: descriptor.sourceAssetId ? [descriptor.sourceAssetId] : [],
    projectSourcePaths:
      !descriptor.sourceAssetId && descriptor.sourceUrl.startsWith('project:/')
        ? [descriptor.sourceUrl.slice('project:/'.length)]
        : [],
    regions: Object.freeze(regions),
    literalOccurrences: Object.freeze(literals),
    cursorNameOccurrences: Object.freeze(cursorNameOccurrences),
    managedMessageOccurrences: Object.freeze(managedMessages),
    diagnostics: Object.freeze(diagnostics),
    complete: artifacts.every((artifact) => artifact.complete),
  };
}

export function collectAuthoringSourceRequirements(
  project: AuthoringProject,
  contributionKey?: AuthoringDependencyContributionKey,
  sourceDescriptors: readonly AuthoringLuaSourceDescriptor[] = collectAuthoringLuaSources(
    project,
    contributionKey === undefined ? undefined : new Set([contributionKey]),
  ),
): readonly string[] {
  const ids = new Set<string>();
  for (const descriptor of sourceDescriptors)
    if (
      descriptor.sourceAssetId &&
      (contributionKey === undefined || descriptor.contributionKey === contributionKey)
    )
      ids.add(descriptor.sourceAssetId);
  let layoutIds: readonly string[];
  if (contributionKey === undefined) layoutIds = Object.keys(project.layouts);
  else {
    try {
      const parsed = contributionKey.startsWith('record:')
        ? (JSON.parse(contributionKey.slice('record:'.length)) as unknown)
        : null;
      layoutIds =
        Array.isArray(parsed) &&
        parsed.length === 3 &&
        parsed[0] === 'record' &&
        parsed[1] === 'layouts' &&
        typeof parsed[2] === 'string'
          ? [parsed[2]]
          : [];
    } catch {
      layoutIds = [];
    }
  }
  for (const id of layoutIds) {
    const record = project.layouts[id];
    if (!record) continue;
    const layout = parseLayoutData(record.data);
    if (!layout) continue;
    for (const ref of layout.dependencies.templates ?? []) ids.add(ref.$ref.id);
  }
  return Object.freeze([...ids].sort());
}

export async function analyzeAuthoringSources(
  project: AuthoringProject,
  snapshot: LuaSourceSnapshot,
  limits: {
    [K in keyof typeof LUA_REFERENCE_ANALYSIS_LIMITS]: number;
  } = LUA_REFERENCE_ANALYSIS_LIMITS,
  contributionKeys?: ReadonlySet<AuthoringDependencyContributionKey>,
  persistentCache?: AuthoringSourceAnalysisCache,
  sourceDescriptors?: readonly AuthoringLuaSourceDescriptor[],
): Promise<
  ReadonlyMap<
    string,
    readonly AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[]
  >
> {
  let bytes = 0;
  let occurrences = 0;
  let byteBudgetExhausted = false;
  let occurrenceBudgetExhausted = false;
  const output = new Map<
    string,
    AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[]
  >();
  const cache =
    persistentCache?.contentArtifacts ?? new Map<string, AuthoringSourceContentArtifact>();
  const countedPhysicalSources = new Set<string>();
  const blockedOwners = new Set<string>();
  const ownerOccurrenceCounts = new Map<string, number>();
  const descriptors = sourceDescriptors ?? collectAuthoringLuaSources(project, contributionKeys);

  const diagnosticContentArtifact = async (
    descriptor: AuthoringLuaSourceDescriptor,
    code: string,
    message: string,
    sourceUrl = descriptor.sourceUrl,
  ): Promise<AuthoringSourceContentArtifact> => ({
    analyzerVersion: AUTHORING_SOURCE_ANALYZER_VERSION,
    sourceContentFingerprint: await sha256(
      JSON.stringify([AUTHORING_SOURCE_ANALYZER_VERSION, code, sourceUrl]),
    ),
    regions: [],
    literalOccurrences: [],
    cursorNameOccurrences: [],
    managedMessageOccurrences: [],
    diagnostics: [{ code, severity: 'warning', message, sourceUrl }],
    complete: false,
  });

  const appendDiagnostic = async (
    descriptor: AuthoringLuaSourceDescriptor,
    code: string,
    message: string,
    sourceUrl = descriptor.sourceUrl,
  ) => {
    if (blockedOwners.has(descriptor.contributionKey)) return;
    const list = output.get(descriptor.contributionKey) ?? [];
    list.push(
      await bindAuthoringSourceOwner(descriptor, [
        await diagnosticContentArtifact(descriptor, code, message, sourceUrl),
      ]),
    );
    output.set(descriptor.contributionKey, list);
  };

  const blockOwner = async (
    descriptor: AuthoringLuaSourceDescriptor,
    code: string,
    message: string,
  ) => {
    if (blockedOwners.has(descriptor.contributionKey)) return;
    const prior = output.get(descriptor.contributionKey) ?? [];
    const priorOccurrences = prior.reduce(
      (sum, analysis) =>
        sum + analysis.literalOccurrences.length + analysis.cursorNameOccurrences.length,
      0,
    );
    occurrences -= priorOccurrences;
    ownerOccurrenceCounts.delete(descriptor.contributionKey);
    output.set(descriptor.contributionKey, [
      await bindAuthoringSourceOwner(descriptor, [
        await diagnosticContentArtifact(descriptor, code, message),
      ]),
    ]);
    blockedOwners.add(descriptor.contributionKey);
  };

  const addBound = async (
    descriptor: AuthoringLuaSourceDescriptor,
    artifact: AuthoringSourceContentArtifact,
  ) => {
    if (blockedOwners.has(descriptor.contributionKey)) return false;
    const candidate = await bindAuthoringSourceOwner(descriptor, [artifact]);
    const bound =
      persistentCache?.ownerProjections.get(candidate.ownerProjectionFingerprint) ?? candidate;
    persistentCache?.ownerProjections.set(candidate.ownerProjectionFingerprint, bound);
    const list = output.get(descriptor.contributionKey) ?? [];
    const currentOccurrences = ownerOccurrenceCounts.get(descriptor.contributionKey) ?? 0;
    const boundOccurrences = bound.literalOccurrences.length + bound.cursorNameOccurrences.length;
    if (currentOccurrences + boundOccurrences > limits.maxLiteralOccurrencesPerSemanticOwner) {
      await blockOwner(
        descriptor,
        'authoring.lua.owner_occurrence_limit',
        'Semantic owner exceeds the fixed literal-occurrence analysis limit.',
      );
      return false;
    }
    if (
      occurrenceBudgetExhausted ||
      occurrences + boundOccurrences > limits.maxSnapshotLiteralOccurrences
    ) {
      occurrenceBudgetExhausted = true;
      await blockOwner(
        descriptor,
        'authoring.lua.snapshot_occurrence_limit',
        'Complete source snapshot exceeded the fixed literal-occurrence limit.',
      );
      return false;
    }
    list.push(bound);
    occurrences += boundOccurrences;
    ownerOccurrenceCounts.set(descriptor.contributionKey, currentOccurrences + boundOccurrences);
    output.set(descriptor.contributionKey, list);
    return true;
  };

  const countSourceBytes = async (
    descriptor: AuthoringLuaSourceDescriptor,
    text: string,
    physicalKey: string,
  ) => {
    if (countedPhysicalSources.has(physicalKey)) return true;
    const sourceBytes = utf8.encode(text).byteLength;
    if (byteBudgetExhausted || bytes + sourceBytes > limits.maxSnapshotBytes) {
      byteBudgetExhausted = true;
      await blockOwner(
        descriptor,
        'authoring.lua.snapshot_byte_limit',
        'Complete source snapshot exceeded the fixed source-byte limit.',
      );
      return false;
    }
    countedPhysicalSources.add(physicalKey);
    bytes += sourceBytes;
    return true;
  };

  const artifactFor = async (
    sourceUrl: string,
    text: string,
    kind: 'lua' | 'rml' | 'rcss',
    hash?: `sha256:${string}`,
  ) => {
    const key = JSON.stringify([
      AUTHORING_SOURCE_ANALYZER_VERSION,
      kind,
      sourceUrl,
      hash ?? (await sha256(text)),
    ]);
    let artifact = cache.get(key);
    if (!artifact) {
      artifact = await analyzeAuthoringSourceContent({
        sourceUrl,
        text,
        kind,
        contentHash: hash,
        limits,
      });
      cache.set(key, artifact);
    }
    return artifact;
  };

  for (const descriptor of descriptors) {
    if (blockedOwners.has(descriptor.contributionKey)) continue;
    let text: string | undefined = descriptor.inlineText;
    let hash: `sha256:${string}` | undefined;
    let physicalKey = `inline:${descriptor.contributionKey}:${descriptor.sourcePath}`;
    if (descriptor.sourceAssetId) {
      const entry = snapshot.entriesByAssetId.get(descriptor.sourceAssetId);
      if (!entry)
        throw new Error(`Missing source snapshot entry for Asset '${descriptor.sourceAssetId}'.`);
      if (entry.status === 'ready') {
        text = entry.text;
        hash = entry.contentHash;
        physicalKey = `asset:${entry.projectRelativePath}:${entry.contentHash}`;
      } else {
        const supplied = entry.diagnostic as Partial<AuthoringDependencyGraphDiagnostic>;
        await appendDiagnostic(
          descriptor,
          supplied.code ?? 'authoring.lua.source_unavailable',
          supplied.message ??
            `Source Asset '${descriptor.sourceAssetId}' is unavailable in the complete source snapshot.`,
        );
      }
    } else if (text === undefined && descriptor.sourceUrl.startsWith('project:/')) {
      const projectRelativePath = descriptor.sourceUrl.slice('project:/'.length);
      const entry = snapshot.entriesByProjectPath?.get(projectRelativePath);
      if (entry?.status === 'ready') {
        text = entry.text;
        hash = entry.contentHash;
        physicalKey = `project-file:${entry.projectRelativePath}:${entry.contentHash}`;
      } else if (entry?.status === 'unavailable') {
        const supplied = entry.diagnostic as Partial<AuthoringDependencyGraphDiagnostic>;
        await appendDiagnostic(
          descriptor,
          supplied.code ?? 'authoring.lua.source_unavailable',
          supplied.message ?? `Project source '${projectRelativePath}' is unavailable.`,
        );
      }
    }
    if (text === undefined) continue;
    if (!(await countSourceBytes(descriptor, text, physicalKey))) continue;
    const artifact = await artifactFor(descriptor.sourceUrl, text, descriptor.sourceKind, hash);
    if (!(await addBound(descriptor, artifact))) continue;

    if (descriptor.sourceKind !== 'rml' || !descriptor.layoutId) continue;
    const queue: {
      text: string;
      assetId?: string;
      sourcePath: string;
      sourceUrl: string;
      depth: number;
    }[] = [
      {
        text,
        assetId: descriptor.sourceAssetId,
        sourcePath: descriptor.sourcePath,
        sourceUrl: descriptor.sourceUrl,
        depth: 0,
      },
    ];
    const visitedTemplates = new Set<string>();
    const visitedScripts = new Set<string>();
    const templateNames = new Map<string, string>();
    const templateUses = new Set<string>();
    let templateCount = 0;
    while (queue.length > 0) {
      const container = queue.shift()!;
      const containingPath = container.assetId ? assetPath(project, container.assetId) : null;
      for (const reference of extractRmlExternalReferences(container.text)) {
        if (reference.kind === 'template-use') {
          templateUses.add(reference.value);
          continue;
        }
        const resolved = resolveLayoutProjectUri(reference.value, containingPath);
        if (reference.kind === 'script') {
          const dependencyPaths = descriptor.dependencyScriptPaths ?? [];
          const matchingPath =
            resolved && dependencyPaths.filter((path) => path === resolved).length === 1
              ? resolved
              : null;
          const entry = matchingPath ? snapshot.entriesByProjectPath?.get(matchingPath) : undefined;
          if (!matchingPath || entry?.status !== 'ready') {
            await appendDiagnostic(
              descriptor,
              'authoring.lua.external_source_unresolved',
              `RML script '${reference.value}' does not resolve to exactly one declared dependency.`,
              container.sourceUrl,
            );
            continue;
          }
          const resolvedPhysicalKey = `project-file:${entry.projectRelativePath}:${entry.contentHash}`;
          if (visitedScripts.has(resolvedPhysicalKey)) continue;
          visitedScripts.add(resolvedPhysicalKey);
          const childDescriptor: AuthoringLuaSourceDescriptor = {
            ...descriptor,
            sourcePath: `/layouts/${escapeJsonPointerSegment(descriptor.layoutId)}/data/dependencies/scripts/${dependencyPaths.indexOf(matchingPath)}`,
            sourceUrl: `project:/${entry.projectRelativePath}`,
            sourceAssetId: undefined,
            sourceKind: 'lua',
          };
          if (!(await countSourceBytes(childDescriptor, entry.text, resolvedPhysicalKey))) break;
          const childArtifact = await artifactFor(
            childDescriptor.sourceUrl,
            entry.text,
            'lua',
            entry.contentHash,
          );
          if (
            !(await addBound(childDescriptor, {
              ...childArtifact,
              regions: childArtifact.regions.map((region) => ({
                ...region,
                sourceKind: 'rml-script-src',
              })),
              literalOccurrences: childArtifact.literalOccurrences.map((literal) => ({
                ...literal,
                sourceKind: 'rml-script-src',
              })),
              managedMessageOccurrences: childArtifact.managedMessageOccurrences.map(
                (occurrence) => ({
                  ...occurrence,
                  sourceLiteral: {
                    ...occurrence.sourceLiteral,
                    sourceKind: 'rml-script-src',
                  },
                }),
              ),
            }))
          )
            break;
          continue;
        }

        const dependencyIds = descriptor.dependencyTemplateIds ?? [];
        const assetId = resolved
          ? declaredLayoutDependencyByResolvedPath(project, dependencyIds, 'template', resolved)
          : null;
        const entry = assetId ? snapshot.entriesByAssetId.get(assetId) : undefined;
        if (!resolved || !assetId || entry?.status !== 'ready') {
          await appendDiagnostic(
            descriptor,
            'authoring.lua.external_source_unresolved',
            `RML template-link '${reference.value}' does not resolve to exactly one declared dependency.`,
            container.sourceUrl,
          );
          continue;
        }
        const resolvedPhysicalKey = `asset:${entry.projectRelativePath}:${entry.contentHash}`;
        if (visitedTemplates.has(resolvedPhysicalKey)) continue;
        if (
          container.depth >= limits.maxTemplateDepth ||
          templateCount >= limits.maxTemplatesPerLayout
        ) {
          await appendDiagnostic(
            descriptor,
            'authoring.lua.template_limit',
            'RML template traversal reached a fixed depth/count limit.',
            `project:/${entry.projectRelativePath}`,
          );
          continue;
        }
        visitedTemplates.add(resolvedPhysicalKey);
        templateCount += 1;
        for (const name of extractTemplateNames(entry.text)) {
          if (templateNames.has(name)) {
            await appendDiagnostic(
              descriptor,
              'authoring.lua.template_name_duplicate',
              `Duplicate RML template name '${name}'.`,
              `project:/${entry.projectRelativePath}`,
            );
          } else templateNames.set(name, assetId);
        }
        const childDescriptor: AuthoringLuaSourceDescriptor = {
          ...descriptor,
          sourcePath: `/layouts/${escapeJsonPointerSegment(descriptor.layoutId)}/data/dependencies/templates/${dependencyIds.indexOf(assetId)}`,
          sourceUrl: `project:/${entry.projectRelativePath}`,
          sourceAssetId: assetId,
        };
        if (!(await countSourceBytes(childDescriptor, entry.text, resolvedPhysicalKey))) break;
        const childArtifact = await artifactFor(
          childDescriptor.sourceUrl,
          entry.text,
          'rml',
          entry.contentHash,
        );
        if (!(await addBound(childDescriptor, childArtifact))) break;
        queue.push({
          text: entry.text,
          assetId,
          sourcePath: childDescriptor.sourcePath,
          sourceUrl: childDescriptor.sourceUrl,
          depth: container.depth + 1,
        });
      }
      if (blockedOwners.has(descriptor.contributionKey)) break;
    }
    for (const name of [...templateUses].sort())
      if (!templateNames.has(name))
        await appendDiagnostic(
          descriptor,
          'authoring.lua.template_name_missing',
          `Unknown RML template name '${name}'.`,
        );
  }
  return new Map([...output].map(([key, value]) => [key, Object.freeze(value)]));
}

export function semanticOwnerFromSourcePath(path: string): AuthoringDependencyNodeKey | null {
  const segments = parseJsonPointer(path);
  const collection = segments[0];
  const id = segments[1];
  return authoringCollectionKeys.includes(collection as AuthoringCollectionKey) && id
    ? recordKey(collection as AuthoringCollectionKey, id)
    : null;
}
