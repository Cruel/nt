import type {
  AuthoringDependencyGraphContribution,
  AuthoringDependencyGraphContributionSet,
  AuthoringDependencyGraphDiagnostic,
  AuthoringDependencyGraphSnapshot,
  ProjectMutationPublication,
} from '../../shared/authoring-dependency-contracts';
import {
  assembleAuthoringDependencyGraph,
  createAuthoringDependencyGraphContributionSet,
  deriveAuthoringDependencyContribution,
  enumerateAuthoringDependencyContributionKeys,
  propertyDefinitionContributionKey,
  recordContributionKey,
  reprojectAuthoringDependencyContributionFromCachedSources,
  replaceAuthoringDependencyGraphContributions,
} from '../../shared/authoring-dependency-graph';
import { classifyAuthoringGraphMutation } from '../../shared/authoring-graph-input-classifier';
import { classifyAssetReverseDependencies } from '../../shared/authoring-graph-input-classifier';
import {
  analyzeAuthoringSourceContent,
  analyzeAuthoringSources,
  collectAuthoringLuaSources,
  collectAuthoringSourceRequirements,
  createAuthoringSourceAnalysisCache,
  type AuthoringSourceAnalysisCache,
} from '../../shared/authoring-source-analysis';
import { buildJsonPointer, parseJsonPointer, type JsonPointer } from '../../shared/json-pointer';
import {
  authoringCollectionKeys,
  type AuthoringCollectionKey,
} from '../../shared/project-schema/authoring-collections';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import type {
  AuthoringSourceAnalysisArtifact,
  LuaSourceSnapshot,
  LuaSourceSnapshotEntry,
} from '../../shared/project-schema/authoring-lua-analysis';
import type { StructurallyAdmittedAuthoringProject } from '../../shared/project-schema/structurally-admitted-authoring-project';
import { LUA_REFERENCE_ANALYSIS_LIMITS } from '../../shared/project-schema/authoring-lua-analysis';
import {
  isSha256Digest,
  type ReadProjectTextSourcesRequest,
  type ReadProjectTextSourcesResponse,
} from '../../shared/project-text-sources';
import { sha256PrefixedUtf8 } from '../../shared/sha256';

export type AuthoringDependencyGraphServiceState =
  | { kind: 'empty' }
  | { kind: 'ready'; snapshot: AuthoringDependencyGraphSnapshot }
  | {
      kind: 'updating';
      phase: 'classifying' | 'resolving-sources' | 'deriving';
      projectInstanceId: string;
      projectRevision: number;
      previousSnapshot: AuthoringDependencyGraphSnapshot | null;
    };

export interface AuthoringDependencyGraphInstrumentation {
  fullBuilds: number;
  contributionDerivations: number;
  sourceReadBatches: number;
  sourceReadEntries: number;
  sourceAnalysisOwners: number;
  symbolReprojections: number;
  graphStableAdvances: number;
  staleCompletions: number;
  classifierFallbacks: number;
  developmentDiagnostics: readonly AuthoringDependencyGraphDiagnostic[];
}

export interface AuthoringDependencyGraphServiceOptions {
  readProjectTextSources(
    request: ReadProjectTextSourcesRequest,
  ): Promise<ReadProjectTextSourcesResponse>;
  getProjectReadSessionId(): string | null;
}

type Analysis = AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>;
type Publication = ProjectMutationPublication<StructurallyAdmittedAuthoringProject>;
type PendingResolver = (snapshot: AuthoringDependencyGraphSnapshot | null) => void;

export class AuthoringDependencyGraphService {
  private readonly listeners = new Set<() => void>();
  private stateValue: AuthoringDependencyGraphServiceState = { kind: 'empty' };
  private contributionSet: AuthoringDependencyGraphContributionSet | null = null;
  private analysesByOwner = new Map<string, readonly Analysis[]>();
  private sourceBytes = new Map<
    string,
    LuaSourceSnapshotEntry<AuthoringDependencyGraphDiagnostic>
  >();
  private ownerPaths = new Map<JsonPointer, readonly string[]>();
  private analysisCache: AuthoringSourceAnalysisCache = createAuthoringSourceAnalysisCache();
  private previousReadySnapshot: AuthoringDependencyGraphSnapshot | null = null;
  private buildToken = 0;
  private graphRevision = 0;
  private processing = false;
  private pendingPublication: Publication | null = null;
  private activePublication: Publication | null = null;
  private pendingAffectedPaths = new Set<JsonPointer>();
  private pendingResolvers: PendingResolver[] = [];
  private readonly metrics: Omit<
    AuthoringDependencyGraphInstrumentation,
    'developmentDiagnostics'
  > & {
    developmentDiagnostics: AuthoringDependencyGraphDiagnostic[];
  } = {
    fullBuilds: 0,
    contributionDerivations: 0,
    sourceReadBatches: 0,
    sourceReadEntries: 0,
    sourceAnalysisOwners: 0,
    symbolReprojections: 0,
    graphStableAdvances: 0,
    staleCompletions: 0,
    classifierFallbacks: 0,
    developmentDiagnostics: [],
  };

  constructor(private readonly options: AuthoringDependencyGraphServiceOptions) {}

  state(): AuthoringDependencyGraphServiceState {
    return this.stateValue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  instrumentation(): AuthoringDependencyGraphInstrumentation {
    return Object.freeze({
      ...this.metrics,
      developmentDiagnostics: Object.freeze([...this.metrics.developmentDiagnostics]),
    });
  }

  currentSnapshot(
    projectInstanceId: string,
    projectRevision: number,
  ): AuthoringDependencyGraphSnapshot | null {
    return this.stateValue.kind === 'ready' &&
      this.stateValue.snapshot.projectInstanceId === projectInstanceId &&
      this.stateValue.snapshot.projectRevision === projectRevision
      ? this.stateValue.snapshot
      : null;
  }

  previousSnapshot(
    projectInstanceId: string,
    projectRevision: number,
  ): AuthoringDependencyGraphSnapshot | null {
    const current = this.currentSnapshot(projectInstanceId, projectRevision);
    const previous = this.previousReadySnapshot;
    return current &&
      previous?.projectInstanceId === projectInstanceId &&
      previous.projectRevision < projectRevision
      ? previous
      : null;
  }

  currentSourceAnalysis(
    projectInstanceId: string,
    projectRevision: number,
    ownerKey?: string,
  ): readonly Analysis[] | null {
    if (!this.currentSnapshot(projectInstanceId, projectRevision)) return null;
    const values = ownerKey
      ? [...(this.analysesByOwner.get(ownerKey) ?? [])]
      : [...this.analysesByOwner.values()].flat();
    return Object.freeze(values);
  }

  publish(publication: Publication): Promise<AuthoringDependencyGraphSnapshot | null> {
    const instance = publication.changeSet.projectInstanceId;
    if (
      this.pendingPublication &&
      this.pendingPublication.changeSet.projectInstanceId !== instance
    ) {
      for (const resolve of this.pendingResolvers.splice(0)) resolve(null);
      this.pendingAffectedPaths.clear();
    }
    const earlier =
      this.pendingPublication?.changeSet.projectInstanceId === instance
        ? this.pendingPublication
        : this.activePublication?.changeSet.projectInstanceId === instance
          ? this.activePublication
          : null;
    if (earlier)
      for (const path of earlier.changeSet.affectedPaths) this.pendingAffectedPaths.add(path);
    for (const path of publication.changeSet.affectedPaths) this.pendingAffectedPaths.add(path);
    this.pendingPublication = earlier
      ? { ...publication, previousProject: earlier.previousProject }
      : publication;
    this.buildToken += 1;
    const promise = new Promise<AuthoringDependencyGraphSnapshot | null>((resolve) => {
      this.pendingResolvers.push(resolve);
    });
    if (!this.processing) void this.processPendingPublications();
    return promise;
  }

  private async processPendingPublications(): Promise<void> {
    this.processing = true;
    while (this.pendingPublication) {
      const publication = this.pendingPublication;
      const affectedPaths = Object.freeze(
        [...this.pendingAffectedPaths].sort(),
      ) as readonly JsonPointer[];
      const resolvers = this.pendingResolvers.splice(0);
      this.pendingPublication = null;
      this.pendingAffectedPaths.clear();
      const merged: Publication = {
        ...publication,
        changeSet: { ...publication.changeSet, affectedPaths },
      };
      this.activePublication = merged;
      let snapshot: AuthoringDependencyGraphSnapshot | null;
      try {
        snapshot = await this.processPublication(merged);
      } finally {
        if (this.activePublication === merged) this.activePublication = null;
      }
      const pending = this.pendingPublication as Publication | null;
      if (pending) {
        if (pending.changeSet.projectInstanceId === merged.changeSet.projectInstanceId) {
          for (const path of affectedPaths) this.pendingAffectedPaths.add(path);
          this.pendingResolvers.unshift(...resolvers);
        } else {
          for (const resolve of resolvers) resolve(null);
        }
      } else {
        for (const resolve of resolvers) resolve(snapshot);
      }
    }
    this.processing = false;
  }

  private async processPublication(
    publication: Publication,
  ): Promise<AuthoringDependencyGraphSnapshot | null> {
    const token = ++this.buildToken;
    const { project, changeSet } = publication;
    const previous = this.stateValue.kind === 'ready' ? this.stateValue.snapshot : null;
    const reset = !previous || previous.projectInstanceId !== changeSet.projectInstanceId;
    if (reset) {
      this.contributionSet = null;
      this.analysesByOwner.clear();
      this.sourceBytes.clear();
      this.ownerPaths.clear();
      this.analysisCache = createAuthoringSourceAnalysisCache();
      this.graphRevision = 0;
      this.previousReadySnapshot = null;
    }

    this.stateValue = {
      kind: 'updating',
      phase: 'classifying',
      projectInstanceId: changeSet.projectInstanceId,
      projectRevision: changeSet.projectRevision,
      previousSnapshot: previous,
    };
    this.notify();

    let impact =
      reset || changeSet.kind === 'load' || changeSet.kind === 'replace'
        ? {
            kind: 'full-rebuild' as const,
            reason: changeSet.kind === 'load' ? ('load' as const) : ('replace' as const),
          }
        : classifyAuthoringGraphMutation(
            changeSet.affectedPaths.filter((path) => !path.startsWith('/editor')),
            {
              contributionKeysByOwnerPath: this.ownerPaths,
              contributionKeysByDerivationKey:
                this.contributionSet?.contributionKeysByDerivationKey,
            },
            { previousProject: publication.previousProject, project },
          );

    if (impact.kind !== 'full-rebuild') {
      const direct = directOwnerAdmission(publication, this.ownerPaths);
      if (direct.contributionKeys.size > 0) {
        const prior = impact.kind === 'incremental' ? impact : null;
        impact = {
          kind: 'incremental',
          contributionKeys: Object.freeze(
            [...new Set([...(prior?.contributionKeys ?? []), ...direct.contributionKeys])].sort(),
          ),
          sourceAnalysisOwnerKeys: Object.freeze(
            [
              ...new Set([
                ...(prior?.sourceAnalysisOwnerKeys ?? []),
                ...direct.sourceAnalysisOwnerKeys,
              ]),
            ].sort(),
          ),
          symbolProjectionOwnerKeys: Object.freeze(
            [...new Set(prior?.symbolProjectionOwnerKeys ?? [])].sort(),
          ),
        };
      }
    }

    if (impact.kind !== 'full-rebuild' && this.contributionSet) {
      const assetOwners = new Set<string>();
      const symbolOwners = new Set<string>();
      for (const path of changeSet.affectedPaths) {
        const match = /^\/assets\/([^/]+)\/data\/(kind|extension|contentHash|source\/path)$/.exec(
          path,
        );
        if (match) {
          const leaf =
            match[2] === 'source/path'
              ? 'path'
              : (match[2] as 'kind' | 'extension' | 'contentHash');
          const owners = classifyAssetReverseDependencies(match[1]!, leaf, {
            contributionKeysByDerivationKey: this.contributionSet.contributionKeysByDerivationKey,
          });
          if (!owners) {
            impact = { kind: 'full-rebuild', reason: 'classifier-fallback' };
            break;
          }
          for (const owner of owners) assetOwners.add(owner);
        }

        const idMatch = /^\/([^/]+)\/([^/]+)\/id$/.exec(path);
        if (idMatch) {
          const collection = idMatch[1]!;
          const mapKey = idMatch[2]!;
          const previousRecord = publication.previousProject?.[
            collection as keyof StructurallyAdmittedAuthoringProject
          ] as Record<string, { id?: string }> | undefined;
          const nextRecord = project[collection as keyof StructurallyAdmittedAuthoringProject] as
            | Record<string, { id?: string }>
            | undefined;
          for (const value of [previousRecord?.[mapKey]?.id, nextRecord?.[mapKey]?.id]) {
            if (!value) continue;
            for (const owner of this.contributionSet.contributionKeysByDecodedLiteral.get(value) ??
              [])
              symbolOwners.add(owner);
          }
        }
      }
      if ((assetOwners.size > 0 || symbolOwners.size > 0) && impact.kind !== 'full-rebuild') {
        const prior = impact.kind === 'incremental' ? impact : null;
        impact = {
          kind: 'incremental',
          contributionKeys: Object.freeze(
            [...new Set([...(prior?.contributionKeys ?? []), ...assetOwners])].sort(),
          ),
          sourceAnalysisOwnerKeys: Object.freeze(
            [...new Set([...(prior?.sourceAnalysisOwnerKeys ?? []), ...assetOwners])].sort(),
          ),
          symbolProjectionOwnerKeys: Object.freeze(
            [...new Set([...(prior?.symbolProjectionOwnerKeys ?? []), ...symbolOwners])].sort(),
          ),
        };
      }
    }

    if (impact.kind === 'graph-stable' && previous && this.contributionSet) {
      this.metrics.graphStableAdvances += 1;
      const snapshot = Object.freeze({ ...previous, projectRevision: changeSet.projectRevision });
      if (!this.isCurrent(token, changeSet.projectInstanceId, changeSet.projectRevision))
        return null;
      this.previousReadySnapshot = previous;
      this.stateValue = { kind: 'ready', snapshot };
      this.notify();
      return snapshot;
    }

    if (impact.kind === 'full-rebuild') {
      if (impact.reason === 'classifier-fallback') {
        this.metrics.classifierFallbacks += 1;
        this.metrics.developmentDiagnostics.push({
          severity: 'warning',
          code: 'authoring_dependency.incremental_index_fallback',
          path: changeSet.affectedPaths[0] ?? '/',
          message:
            'Incremental graph attribution was unavailable; rebuilt the complete graph to avoid publishing stale dependencies.',
        });
      }
      return this.fullBuild(token, project, changeSet.projectInstanceId, changeSet.projectRevision);
    }

    if (impact.kind === 'graph-stable') {
      return this.fullBuild(token, project, changeSet.projectInstanceId, changeSet.projectRevision);
    }

    if (!this.contributionSet)
      return this.fullBuild(token, project, changeSet.projectInstanceId, changeSet.projectRevision);
    return this.incrementalBuild(
      token,
      project,
      changeSet.projectInstanceId,
      changeSet.projectRevision,
      impact,
    );
  }

  private async fullBuild(
    token: number,
    project: StructurallyAdmittedAuthoringProject,
    instance: string,
    revision: number,
  ) {
    this.metrics.fullBuilds += 1;
    const ownerKeys = new Set(enumerateAuthoringDependencyContributionKeys(project));
    const snapshot = await this.resolveSources(token, project, instance, revision, ownerKeys);
    if (!snapshot) return null;
    this.stateValue = {
      ...(this.stateValue as Extract<AuthoringDependencyGraphServiceState, { kind: 'updating' }>),
      phase: 'deriving',
    };
    const analyses = analyzeAuthoringSources(
      project,
      snapshot,
      undefined,
      ownerKeys,
      this.analysisCache,
    );
    this.metrics.sourceAnalysisOwners += ownerKeys.size;
    const contributions: AuthoringDependencyGraphContribution[] = [];
    for (const key of ownerKeys) {
      const contribution = reprojectAuthoringDependencyContributionFromCachedSources(
        project,
        key,
        analyses.get(key) ?? [],
      );
      if (contribution) contributions.push(contribution);
    }
    this.metrics.contributionDerivations += contributions.length;
    return this.publishBuilt(
      token,
      instance,
      revision,
      createAuthoringDependencyGraphContributionSet(contributions),
      analyses,
    );
  }

  private async incrementalBuild(
    token: number,
    project: StructurallyAdmittedAuthoringProject,
    instance: string,
    revision: number,
    impact: Extract<ReturnType<typeof classifyAuthoringGraphMutation>, { kind: 'incremental' }>,
  ) {
    const sourceOwners = new Set(impact.sourceAnalysisOwnerKeys);
    let sourceSnapshot: LuaSourceSnapshot<AuthoringDependencyGraphDiagnostic> | null = null;
    if (sourceOwners.size > 0) {
      sourceSnapshot = await this.resolveSources(token, project, instance, revision, sourceOwners);
      if (!sourceSnapshot) return null;
      const next = analyzeAuthoringSources(
        project,
        sourceSnapshot,
        undefined,
        sourceOwners,
        this.analysisCache,
      );
      this.metrics.sourceAnalysisOwners += sourceOwners.size;
      for (const key of sourceOwners) this.analysesByOwner.set(key, next.get(key) ?? []);
    }
    this.stateValue = {
      ...(this.stateValue as Extract<AuthoringDependencyGraphServiceState, { kind: 'updating' }>),
      phase: 'deriving',
    };
    const keys = new Set([
      ...impact.contributionKeys,
      ...impact.symbolProjectionOwnerKeys,
      ...sourceOwners,
    ]);
    const replacements: AuthoringDependencyGraphContribution[] = [];
    const removed: string[] = [];
    for (const key of keys) {
      const contribution =
        impact.symbolProjectionOwnerKeys.includes(key) ||
        sourceOwners.has(key) ||
        this.analysesByOwner.has(key)
          ? reprojectAuthoringDependencyContributionFromCachedSources(
              project,
              key,
              this.analysesByOwner.get(key) ?? [],
            )
          : deriveAuthoringDependencyContribution(project, key, { mode: 'disabled' });
      if (contribution) replacements.push(contribution);
      else {
        removed.push(key);
        this.analysesByOwner.delete(key);
      }
    }
    this.metrics.symbolReprojections += impact.symbolProjectionOwnerKeys.length;
    this.metrics.contributionDerivations += replacements.length;
    const contributionSet = replaceAuthoringDependencyGraphContributions(
      this.contributionSet!,
      replacements,
      removed,
    );
    return this.publishBuilt(token, instance, revision, contributionSet, this.analysesByOwner);
  }

  private async resolveSources(
    token: number,
    project: StructurallyAdmittedAuthoringProject,
    instance: string,
    revision: number,
    owners: ReadonlySet<string>,
  ): Promise<LuaSourceSnapshot<AuthoringDependencyGraphDiagnostic> | null> {
    this.stateValue = {
      ...(this.stateValue as Extract<AuthoringDependencyGraphServiceState, { kind: 'updating' }>),
      phase: 'resolving-sources',
    };
    const requiredIds = new Set<string>();
    for (const owner of owners)
      for (const id of collectAuthoringSourceRequirements(project, owner)) requiredIds.add(id);
    const groups = new Map<
      string,
      { path: string; hash: `sha256:${string}`; assetIds: string[] }
    >();
    const entries = new Map<string, LuaSourceSnapshotEntry<AuthoringDependencyGraphDiagnostic>>();
    let admittedBytes = 0;
    let admittedOccurrences = 0;
    const admittedPhysical = new Set<string>();
    for (const descriptor of collectAuthoringLuaSources(project, owners)) {
      let text = descriptor.inlineText;
      let contentHash = text === undefined ? undefined : sha256PrefixedUtf8(text);
      let physicalKey =
        text === undefined
          ? undefined
          : `inline:${descriptor.sourceKind}:${descriptor.sourceUrl}:${contentHash}`;
      if (descriptor.sourceAssetId) {
        const parsed = parseAssetData(project.assets[descriptor.sourceAssetId]?.data);
        if (parsed?.contentHash && isSha256Digest(parsed.contentHash)) {
          const cached = this.sourceBytes.get(
            `${instance}\u0000${parsed.source.path}\u0000${parsed.contentHash}`,
          );
          if (cached?.status === 'ready') {
            text = cached.text;
            contentHash = cached.contentHash;
            physicalKey = `asset:${cached.projectRelativePath}:${cached.contentHash}`;
          }
        }
      }
      if (text === undefined || contentHash === undefined || physicalKey === undefined) continue;
      if (admittedPhysical.has(physicalKey)) continue;
      admittedPhysical.add(physicalKey);
      admittedBytes += new TextEncoder().encode(text).byteLength;
      const cacheKey = JSON.stringify([
        'authoring-source-analysis-v1',
        descriptor.sourceKind,
        descriptor.sourceUrl,
        contentHash,
      ]);
      const artifact =
        this.analysisCache.contentArtifacts.get(cacheKey) ??
        analyzeAuthoringSourceContent({
          sourceUrl: descriptor.sourceUrl,
          text,
          kind: descriptor.sourceKind,
          contentHash,
        });
      this.analysisCache.contentArtifacts.set(cacheKey, artifact);
      admittedOccurrences += artifact.literalOccurrences.length;
    }
    for (const assetId of [...requiredIds].sort()) {
      const asset = project.assets[assetId];
      const parsed = asset ? parseAssetData(asset.data) : null;
      const path = parsed?.source.path;
      const hash = parsed?.contentHash;
      if (!path || !hash || !isSha256Digest(hash)) {
        entries.set(
          assetId,
          unavailableAsset(
            assetId,
            hash ?? null,
            'authoring_source.reimport_required',
            'Source Asset is missing a valid recorded SHA-256 hash.',
          ),
        );
        continue;
      }
      const physicalKey = `${path}\u0000${hash}`;
      const cached = this.sourceBytes.get(`${instance}\u0000${physicalKey}`);
      if (cached) {
        entries.set(assetId, {
          ...cached,
          assetId,
        } as LuaSourceSnapshotEntry<AuthoringDependencyGraphDiagnostic>);
        continue;
      }
      const group = groups.get(physicalKey) ?? { path, hash, assetIds: [] };
      group.assetIds.push(assetId);
      groups.set(physicalKey, group);
    }
    if (
      admittedBytes > LUA_REFERENCE_ANALYSIS_LIMITS.maxSnapshotBytes ||
      admittedOccurrences > LUA_REFERENCE_ANALYSIS_LIMITS.maxSnapshotLiteralOccurrences
    ) {
      for (const group of groups.values())
        for (const assetId of group.assetIds)
          entries.set(
            assetId,
            unavailableAsset(
              assetId,
              group.hash,
              admittedBytes > LUA_REFERENCE_ANALYSIS_LIMITS.maxSnapshotBytes
                ? 'authoring.lua.snapshot_byte_limit'
                : 'authoring.lua.snapshot_occurrence_limit',
              'Complete logical source snapshot exceeds the fixed analysis budget before additional source reads.',
            ),
          );
      groups.clear();
    }
    if (groups.size > 0) {
      const sessionId = this.options.getProjectReadSessionId();
      if (!sessionId) {
        for (const group of groups.values())
          for (const assetId of group.assetIds)
            entries.set(
              assetId,
              unavailableAsset(
                assetId,
                group.hash,
                'authoring_source.no_session',
                'No active project text-read session is available.',
              ),
            );
      } else {
        const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
        const request: ReadProjectTextSourcesRequest = {
          projectReadSessionId: sessionId,
          entries: sorted.map(([key, group], index) => ({
            readKey: `r${index}:${key.length}`,
            projectRelativePath: group.path,
            expectedContentHash: group.hash,
          })),
        };
        this.metrics.sourceReadBatches += 1;
        this.metrics.sourceReadEntries += request.entries.length;
        const response = await this.options.readProjectTextSources(request);
        if (!this.isCurrent(token, instance, revision)) return null;
        const byReadKey = new Map(response.entries.map((entry) => [entry.readKey, entry]));
        request.entries.forEach((requested, index) => {
          const [, group] = sorted[index]!;
          const result = byReadKey.get(requested.readKey);
          for (const assetId of group.assetIds) {
            const value =
              result?.status === 'ready'
                ? ({
                    ...result,
                    assetId,
                  } as LuaSourceSnapshotEntry<AuthoringDependencyGraphDiagnostic>)
                : unavailableAsset(
                    assetId,
                    group.hash,
                    `authoring_source.${result?.code ?? 'missing_response'}`,
                    result?.message ?? 'Text source read returned no result.',
                  );
            entries.set(assetId, value);
            this.sourceBytes.set(`${instance}\u0000${group.path}\u0000${group.hash}`, value);
          }
        });
      }
    }
    return Object.freeze({ entriesByAssetId: new Map(entries) });
  }

  private publishBuilt(
    token: number,
    instance: string,
    revision: number,
    contributionSet: AuthoringDependencyGraphContributionSet,
    analyses: ReadonlyMap<string, readonly Analysis[]>,
  ): AuthoringDependencyGraphSnapshot | null {
    if (!this.isCurrent(token, instance, revision)) return null;
    const graph = assembleAuthoringDependencyGraph(contributionSet);
    this.contributionSet = contributionSet;
    this.analysesByOwner = new Map(analyses);
    this.ownerPaths = buildOwnerPathIndex(contributionSet);
    const priorGraph =
      this.stateValue.kind === 'updating' ? this.stateValue.previousSnapshot?.graph : null;
    this.previousReadySnapshot =
      this.stateValue.kind === 'updating' ? this.stateValue.previousSnapshot : null;
    if (priorGraph !== graph) this.graphRevision += 1;
    const snapshot = Object.freeze({
      projectInstanceId: instance,
      projectRevision: revision,
      graphRevision: this.graphRevision,
      graph,
    });
    this.stateValue = { kind: 'ready', snapshot };
    this.notify();
    return snapshot;
  }

  private isCurrent(token: number, instance: string, revision: number): boolean {
    const current =
      token === this.buildToken &&
      this.stateValue.kind === 'updating' &&
      this.stateValue.projectInstanceId === instance &&
      this.stateValue.projectRevision === revision;
    if (!current) this.metrics.staleCompletions += 1;
    return current;
  }
}

function directOwnerAdmission(
  publication: Publication,
  ownerPaths: ReadonlyMap<JsonPointer, readonly string[]>,
): { contributionKeys: Set<string>; sourceAnalysisOwnerKeys: Set<string> } {
  const contributionKeys = new Set<string>();
  const sourceAnalysisOwnerKeys = new Set<string>();
  for (const path of publication.changeSet.affectedPaths) {
    const segments = parseJsonPointer(path);
    const root = segments[0];
    const id = segments[1];
    if (!root || !id) continue;
    if (root === 'properties') {
      const ownerPath = buildJsonPointer(['properties', id]);
      const previous = publication.previousProject?.properties[id];
      const current = publication.project.properties[id];
      if (
        (previous || current) &&
        (!ownerPaths.has(ownerPath) || Boolean(previous) !== Boolean(current))
      )
        contributionKeys.add(propertyDefinitionContributionKey(id));
      continue;
    }
    if (!authoringCollectionKeys.includes(root as AuthoringCollectionKey)) continue;
    const collection = root as AuthoringCollectionKey;
    const ownerPath = buildJsonPointer([collection, id]);
    const previous = publication.previousProject?.[collection][id];
    const current = publication.project[collection][id];
    if (!previous && !current) continue;
    if (ownerPaths.has(ownerPath) && Boolean(previous) === Boolean(current)) continue;
    const key = recordContributionKey(collection, id);
    contributionKeys.add(key);
    if (Boolean(previous) !== Boolean(current)) sourceAnalysisOwnerKeys.add(key);
  }
  return { contributionKeys, sourceAnalysisOwnerKeys };
}

function buildOwnerPathIndex(
  set: AuthoringDependencyGraphContributionSet,
): Map<JsonPointer, readonly string[]> {
  const mutable = new Map<JsonPointer, string[]>();
  for (const contribution of set.byKey.values()) {
    const values = mutable.get(contribution.ownerPath) ?? [];
    values.push(contribution.key);
    mutable.set(contribution.ownerPath, values);
  }
  return new Map(
    [...mutable].map(([path, keys]) => [path, Object.freeze([...new Set(keys)].sort())]),
  );
}

function unavailableAsset(
  assetId: string,
  expectedContentHash: string | null,
  code: string,
  message: string,
): LuaSourceSnapshotEntry<AuthoringDependencyGraphDiagnostic> {
  return {
    status: 'unavailable',
    assetId,
    expectedContentHash,
    diagnostic: { severity: 'warning', code, path: `/assets/${assetId}` as JsonPointer, message },
  };
}
