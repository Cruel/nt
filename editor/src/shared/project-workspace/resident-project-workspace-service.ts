import {
  captureProjectSourceInventory,
  projectSourceInventoriesEqual,
  type ProjectSourceDiscoveryScope,
  type ProjectSourceInventory,
} from '../project-source-inventory';
import { parseAssetData } from '../project-schema/authoring-assets';
import { parseLayoutData } from '../project-schema/authoring-layouts';
import { parseMaterialData } from '../project-schema/authoring-materials';
import type { AuthoringProject } from '../project-schema/authoring-project';
import { parseScriptModuleData } from '../project-schema/authoring-script-modules';
import {
  stripEditorProjectState,
  type EditorProjectState,
} from '../project-schema/editor-project-state';
import { sha256PrefixedBytes } from '../web-crypto';
import {
  physicalPathRequiredBySemanticPaths,
  scopedAuthorityRelevantDeltaPaths,
  scopedAuthoritySignature,
  type ScopedReadAuthorityToken,
} from '../scoped-read-authority';
import type { ProjectWorkspaceFileSystem } from './project-workspace-file-system';
import {
  assetSourcePaths,
  ProjectWorkspaceService,
  type LoadedProjectWorkspaceSnapshot,
  type ProjectWorkspaceDependencyAnalysis,
  type ProjectWorkspaceOpenOptions,
  type ProjectWorkspaceOpenResult,
  type ProjectWorkspaceSnapshot,
  type ProjectWorkspaceWriteOptions,
} from './project-workspace-service';
import { ProjectWorkspaceMutationError } from './project-workspace-transaction';
import {
  ResidentProjectWorkspaceSession,
  type ResidentProjectGenerationIdentity,
} from './resident-project-workspace-session';

export type ResidentProjectWorkspaceServiceFactory = (
  fileSystem: ProjectWorkspaceFileSystem,
) => ProjectWorkspaceService;

export interface ResidentProjectAuthorityRequest {
  readonly projectRoot: string;
  /** Present only when the native authority configuration must be created or replaced. */
  readonly authoritativePaths?: readonly string[];
  /** Present together with authoritativePaths; omitted for ordinary observations. */
  readonly discoveryScopes?: readonly ProjectSourceDiscoveryScope[];
  /** Snapshot preparation may request retained native metadata for external Asset payloads. */
  readonly includeManifestEntries?: boolean;
}

export interface ResidentProjectAuthorityObservation {
  readonly previousAuthority: 'untracked' | 'proven' | 'dirty' | 'unknown';
  readonly unchanged: boolean;
  readonly fullRescan: boolean;
  readonly watcherPaths: readonly string[];
  readonly delta: Readonly<{
    added: readonly string[];
    changed: readonly string[];
    removed: readonly string[];
  }>;
  readonly manifest: Readonly<{
    canonicalRoot: string;
    entries: readonly Readonly<{
      path: string;
      sourceIdentity?: string;
      byteSize?: number;
      mtimeNanoseconds?: string | null;
      contentHash?: string | null;
    }>[];
  }>;
}

/** Native daemon physical-authority seam. Watchers provide hints; observe() is the proof. */
export interface ResidentProjectAuthority {
  observe(request: ResidentProjectAuthorityRequest): Promise<ResidentProjectAuthorityObservation>;
  release(projectRoot: string): void;
}

const residentDiscoveryScopes: readonly ProjectSourceDiscoveryScope[] = Object.freeze([
  { root: 'i18n', extensions: ['.json'], excludedPrefixes: [] },
  { root: 'records', extensions: ['.json', '.lua', '.rcss', '.rml'], excludedPrefixes: [] },
  { root: 'scripts', extensions: ['.lua'], excludedPrefixes: [] },
]);

function certificationDelay(name: string): void {
  if (process.env.NOVELTEA_CLI_CERTIFICATION !== '1') return;
  const delay = Number(process.env[name] ?? '0');
  if (!Number.isSafeInteger(delay) || delay <= 0 || delay > 5_000) return;
  const deadline = Date.now() + delay;
  while (Date.now() < deadline) {
    // Certification-only deterministic race seam between transaction commit and physical proof.
  }
}

function isResidentSemanticSourcePath(path: string): boolean {
  return (
    path === 'project.json' ||
    path === 'editor.json' ||
    path === 'traits.json' ||
    /^records\/[^/]+\/.+\.(?:json|lua|rml|rcss)$/u.test(path) ||
    /^scripts\/.+\.lua$/u.test(path) ||
    /^i18n\/.+\.json$/u.test(path)
  );
}

function semanticObservationDelta(observation: ResidentProjectAuthorityObservation) {
  const added = observation.delta.added.filter(isResidentSemanticSourcePath);
  const changed = observation.delta.changed.filter(isResidentSemanticSourcePath);
  const removed = observation.delta.removed.filter(isResidentSemanticSourcePath);
  return {
    added,
    changed,
    removed,
    paths: [...new Set([...added, ...changed, ...removed])].sort(),
    structural: added.length > 0 || removed.length > 0,
  };
}

function assetRecordSourcePath(project: AuthoringProject, id: string): string | null {
  const record = project.assets[id];
  if (!record) return null;
  return parseAssetData(record.data)?.source.path ?? null;
}

function assetAuthorityPathsAfterChanges(
  currentPaths: readonly string[],
  before: AuthoringProject,
  after: AuthoringProject,
  changedSources: readonly string[],
  structural: boolean,
): readonly string[] {
  if (structural) return Object.freeze(assetSourcePaths(after));
  for (const path of changedSources) {
    const match = /^records\/assets\/([^/]+)\.json$/u.exec(path);
    if (!match) continue;
    const id = match[1]!;
    if (assetRecordSourcePath(before, id) !== assetRecordSourcePath(after, id))
      return Object.freeze(assetSourcePaths(after));
  }
  return currentPaths;
}

async function workspaceSettled(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
): Promise<boolean> {
  const transactions = fileSystem.joinPath(projectRoot, '.noveltea/transactions');
  const metadata = await fileSystem.readPathMetadata?.(transactions);
  if (!metadata) return false;
  return (
    metadata.kind === 'missing' ||
    (metadata.kind === 'directory' && (await fileSystem.listDirectory(transactions)).length === 0)
  );
}

async function captureResidentInventory(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
): Promise<ProjectSourceInventory | null> {
  if (!fileSystem.readPathMetadata) return null;
  try {
    if (!(await workspaceSettled(fileSystem, snapshot.projectRoot))) return null;
    const inventory = await captureProjectSourceInventory(fileSystem, snapshot.projectRoot, {
      // Record, script, and localization source membership is discovered so additions/deletions
      // remain representable as structural generation changes instead of failing inventory capture.
      authoritativePaths: [
        'project.json',
        'editor.json',
        'traits.json',
        ...assetSourcePaths(snapshot.project),
      ],
      discoveryScopes: residentDiscoveryScopes,
    });
    return (await workspaceSettled(fileSystem, snapshot.projectRoot)) ? inventory : null;
  } catch {
    return null;
  }
}

async function captureResidentAuthority(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
): Promise<ProjectSourceInventory | null> {
  const inventory = await captureResidentInventory(fileSystem, snapshot);
  if (!inventory) return null;
  const inputs = new Map(inventory.entries.map((entry) => [entry.path, entry]));
  try {
    for (const relativePath of snapshot.canonicalSourceFiles) {
      const admitted = snapshot.fileRevisions[relativePath];
      const input = inputs.get(relativePath);
      if (!admitted || !input || admitted.byteSize !== input.byteSize) return null;
      const revision = await fileSystem.readFileRevision(
        fileSystem.joinPath(snapshot.projectRoot, relativePath),
      );
      if (revision.byteSize !== admitted.byteSize || revision.contentHash !== admitted.contentHash)
        return null;
    }
    return inventory;
  } catch {
    return null;
  }
}

type SuccessfulOpen = Extract<ProjectWorkspaceOpenResult, { ok: true }>;
type ProjectWorkspaceWriteResult = Awaited<ReturnType<ProjectWorkspaceService['write']>>;

const PORTABLE_RESIDENT_PROJECT_SNAPSHOT_VERSION = 2 as const;

export type PortableResidentProjectAuthorityEntry = Readonly<{
  path: string;
  sourceIdentity?: string;
  byteSize?: number;
  mtimeNanoseconds?: string | null;
  contentHash?: string | null;
}>;

export type PortableResidentProjectTextSource = Readonly<{
  contentHash: `sha256:${string}`;
  text: string;
}>;

type PortableResidentProjectSnapshot = Readonly<{
  version: typeof PORTABLE_RESIDENT_PROJECT_SNAPSHOT_VERSION;
  identity: ResidentProjectGenerationIdentity;
  snapshot: LoadedProjectWorkspaceSnapshot;
  editorState: EditorProjectState;
  diagnostics: SuccessfulOpen['diagnostics'];
  sourceContributions: SuccessfulOpen['sourceContributions'];
  validationContributions: SuccessfulOpen['validationContributions'];
  validationWork: SuccessfulOpen['validationWork'];
  sourceWork: SuccessfulOpen['sourceWork'];
  externalAssets: readonly PortableResidentProjectAuthorityEntry[];
  physicalAuthority: readonly PortableResidentProjectAuthorityEntry[];
  projectTextSources: Readonly<Record<string, PortableResidentProjectTextSource>>;
}>;

type PortableResidentProjectOwnerMetadata = Readonly<{
  version: typeof PORTABLE_RESIDENT_PROJECT_SNAPSHOT_VERSION;
  canonicalRoot: string;
  nativeAssetSourcePaths: readonly string[];
}>;

export interface PreparedPortableResidentProjectSnapshot {
  readonly projectRoot: string;
  readonly identity: ResidentProjectGenerationIdentity;
  readonly snapshotText: string;
  readonly ownerMetadataText: string;
}

type ResidentEntry = {
  readonly canonicalRoot: string;
  readonly session: ResidentProjectWorkspaceSession;
  immutablePinned: boolean;
  authority: ProjectSourceInventory | null;
  readonly pendingNativeSemanticPaths: Set<string>;
  pendingNativeStructuralChange: boolean;
  pendingNativeExternalAssetChange: boolean;
  nativeAssetSourcePaths: readonly string[];
  nativeAssetSourcePathSet: ReadonlySet<string>;
  lastUsedAtMilliseconds: number;
  portableSnapshot: PreparedPortableResidentProjectSnapshot | null;
  pinnedPhysicalAuthority: readonly PortableResidentProjectAuthorityEntry[] | null;
  pinnedExternalAssets: readonly PortableResidentProjectAuthorityEntry[] | null;
  pinnedProjectTextSources: Readonly<Record<string, PortableResidentProjectTextSource>> | null;
};

export type PinnedPortableResidentProjectInputs = Readonly<{
  sourceContributions: SuccessfulOpen['sourceContributions'];
  physicalAuthority: readonly PortableResidentProjectAuthorityEntry[];
  externalAssets: readonly PortableResidentProjectAuthorityEntry[];
  projectTextSources: Readonly<Record<string, PortableResidentProjectTextSource>>;
}>;

function portableProjectTextSourcePaths(project: AuthoringProject): readonly string[] {
  const paths = new Set<string>();
  for (const record of Object.values(project.scripts)) {
    const data = parseScriptModuleData(record.data);
    if (data?.source.kind === 'project-file') paths.add(data.source.path);
  }
  for (const record of Object.values(project.layouts)) {
    const data = parseLayoutData(record.data);
    for (const source of data?.dependencies.scripts ?? []) paths.add(source);
  }
  for (const record of Object.values(project.materials)) {
    const shader = parseMaterialData(record.data)?.shader;
    for (const source of [shader?.vertex, shader?.fragment, shader?.varying])
      if (source?.kind === 'project') paths.add(source.path);
  }
  return [...paths].sort();
}

function portableAuthorityEntriesValid(
  value: unknown,
): value is readonly PortableResidentProjectAuthorityEntry[] {
  return (
    Array.isArray(value) &&
    value.every((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false;
      const entry = candidate as Record<string, unknown>;
      return (
        typeof entry.path === 'string' &&
        (entry.sourceIdentity === undefined || typeof entry.sourceIdentity === 'string') &&
        (entry.byteSize === undefined ||
          (Number.isSafeInteger(entry.byteSize) && (entry.byteSize as number) >= 0)) &&
        (entry.mtimeNanoseconds === undefined ||
          entry.mtimeNanoseconds === null ||
          typeof entry.mtimeNanoseconds === 'string') &&
        (entry.contentHash === undefined ||
          entry.contentHash === null ||
          typeof entry.contentHash === 'string')
      );
    })
  );
}

function portableTextSourcesValid(
  value: unknown,
): value is Readonly<Record<string, PortableResidentProjectTextSource>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([path, candidate]) => {
    if (!path || !candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      return false;
    const source = candidate as Record<string, unknown>;
    return (
      typeof source.text === 'string' &&
      typeof source.contentHash === 'string' &&
      /^sha256:[0-9a-f]{64}$/u.test(source.contentHash)
    );
  });
}

type SnapshotBinding = Readonly<{
  entry: ResidentEntry;
  canonicalSnapshot: LoadedProjectWorkspaceSnapshot;
  generation: ResidentProjectGenerationIdentity;
}>;

function inventoryByPath(
  inventory: ProjectSourceInventory,
): Map<string, ProjectSourceInventory['entries'][number]> {
  return new Map(inventory.entries.map((entry) => [entry.path, entry]));
}

function changedInventoryPaths(
  previous: ProjectSourceInventory,
  current: ProjectSourceInventory,
): Readonly<{ structural: boolean; paths: readonly string[] }> {
  const previousByPath = inventoryByPath(previous);
  const currentByPath = inventoryByPath(current);
  const paths = new Set([...previousByPath.keys(), ...currentByPath.keys()]);
  const changed: string[] = [];
  let structural = previousByPath.size !== currentByPath.size;
  for (const path of paths) {
    const before = previousByPath.get(path);
    const after = currentByPath.get(path);
    if (!before || !after) {
      structural = true;
      changed.push(path);
      continue;
    }
    if (before.byteSize !== after.byteSize || before.mtimeNanoseconds !== after.mtimeNanoseconds)
      changed.push(path);
  }
  return { structural, paths: Object.freeze(changed.sort()) };
}

function mergeInventoryPaths(
  base: ProjectSourceInventory,
  current: ProjectSourceInventory,
  paths: readonly string[],
): ProjectSourceInventory {
  const merged = inventoryByPath(base);
  const currentByPath = inventoryByPath(current);
  for (const path of paths) {
    const entry = currentByPath.get(path);
    if (entry) merged.set(path, entry);
    else merged.delete(path);
  }
  return Object.freeze({
    entries: Object.freeze(
      [...merged.values()].sort((left, right) => left.path.localeCompare(right.path)),
    ),
  });
}

/**
 * ProjectWorkspaceService adapter backed by the shared resident session core.
 * A physical Project root has one coherent in-memory generation. Request-time metadata inventories
 * establish disk authority; exact file reads remain limited to changed semantic sources.
 */
export class ResidentProjectWorkspaceService extends ProjectWorkspaceService {
  private readonly sessions = new Map<string, ResidentEntry>();
  // A rejected candidate can configure native authority without becoming the coherent generation.
  private readonly installedNativeAssetPaths = new Map<string, readonly string[]>();
  private readonly snapshotBindings = new WeakMap<ProjectWorkspaceSnapshot, SnapshotBinding>();

  constructor(
    private readonly residentFileSystem: ProjectWorkspaceFileSystem,
    private readonly createSessionWorkspace: ResidentProjectWorkspaceServiceFactory = (
      fileSystem,
    ) => new ProjectWorkspaceService(fileSystem),
    private readonly nativeAuthority?: ResidentProjectAuthority,
    private readonly residentSessionEpoch?: number,
  ) {
    super(residentFileSystem);
    if (
      residentSessionEpoch !== undefined &&
      (!Number.isSafeInteger(residentSessionEpoch) || residentSessionEpoch <= 0)
    )
      throw new Error('Resident Project session epoch must be a positive safe integer.');
  }

  private captureInventory(
    snapshot: LoadedProjectWorkspaceSnapshot,
  ): Promise<ProjectSourceInventory | null> {
    return captureResidentInventory(this.residentFileSystem, snapshot);
  }

  private authorityRequest(
    canonicalRoot: string,
    nativeAssetSourcePaths?: readonly string[],
    includeManifestEntries = false,
  ): ResidentProjectAuthorityRequest {
    if (!nativeAssetSourcePaths)
      return {
        projectRoot: canonicalRoot,
        ...(includeManifestEntries ? { includeManifestEntries: true } : {}),
      };
    return {
      projectRoot: canonicalRoot,
      authoritativePaths: ['project.json', 'editor.json', 'traits.json', ...nativeAssetSourcePaths],
      discoveryScopes: residentDiscoveryScopes,
      ...(includeManifestEntries ? { includeManifestEntries: true } : {}),
    };
  }

  private async observeNativeAuthority(
    canonicalRoot: string,
    nativeAssetSourcePaths: readonly string[],
    includeManifestEntries = false,
  ): Promise<ResidentProjectAuthorityObservation> {
    if (!this.nativeAuthority)
      throw new Error('Native Project authority is unavailable for resident reconciliation.');
    const installed = this.installedNativeAssetPaths.get(canonicalRoot);
    try {
      const observation = await this.nativeAuthority.observe(
        this.authorityRequest(
          canonicalRoot,
          installed === nativeAssetSourcePaths ? undefined : nativeAssetSourcePaths,
          includeManifestEntries,
        ),
      );
      this.installedNativeAssetPaths.set(canonicalRoot, nativeAssetSourcePaths);
      return observation;
    } catch (error) {
      // The host may have installed the request before the observation failed.
      this.installedNativeAssetPaths.delete(canonicalRoot);
      throw error;
    }
  }

  private recordNativeObservation(
    entry: ResidentEntry,
    observation: ResidentProjectAuthorityObservation,
  ): ReturnType<typeof semanticObservationDelta> {
    const delta = semanticObservationDelta(observation);
    const externalAssetChanged = [
      ...observation.delta.added,
      ...observation.delta.changed,
      ...observation.delta.removed,
    ].some((path) => entry.nativeAssetSourcePathSet.has(path));
    if (externalAssetChanged) {
      entry.portableSnapshot = null;
      entry.pendingNativeExternalAssetChange = true;
    }
    delta.paths.forEach((path) => entry.pendingNativeSemanticPaths.add(path));
    entry.pendingNativeStructuralChange ||= delta.structural;
    return delta;
  }

  private bindSnapshot(entry: ResidentEntry, snapshot: LoadedProjectWorkspaceSnapshot): void {
    entry.lastUsedAtMilliseconds = Date.now();
    this.snapshotBindings.set(snapshot, {
      entry,
      canonicalSnapshot: snapshot,
      generation: entry.session.generationIdentity(),
    });
  }

  private logicalView(
    entry: ResidentEntry,
    opened: SuccessfulOpen,
    logicalRoot: string,
  ): SuccessfulOpen {
    if (logicalRoot === entry.canonicalRoot) {
      this.bindSnapshot(entry, opened.snapshot);
      return opened;
    }
    const snapshot = Object.freeze({
      ...opened.snapshot,
      projectRoot: logicalRoot,
      manifestPath: this.residentFileSystem.joinPath(logicalRoot, 'project.json'),
    }) as LoadedProjectWorkspaceSnapshot;
    this.snapshotBindings.set(snapshot, {
      entry,
      canonicalSnapshot: opened.snapshot,
      generation: entry.session.generationIdentity(),
    });
    return { ...opened, snapshot };
  }

  private async canonicalProjectRoot(projectRoot: string): Promise<string | null> {
    try {
      return this.residentFileSystem.resolvePath(
        await this.residentFileSystem.realpath(projectRoot),
      );
    } catch {
      return null;
    }
  }

  private async openCold(
    canonicalRoot: string,
    options: ProjectWorkspaceOpenOptions,
    identity?: ResidentProjectGenerationIdentity,
  ): Promise<ProjectWorkspaceOpenResult> {
    const workspace = this.createSessionWorkspace(this.residentFileSystem);
    const admittedIdentity =
      identity ??
      (this.residentSessionEpoch === undefined
        ? undefined
        : { sessionEpoch: this.residentSessionEpoch, generation: 1 });
    const admissionOptions = {
      ...options,
      // Persistent semantic contribution hydration was removed. These reuse hooks remain valid for
      // RAM-resident generation/snapshot reuse, but a cold Project always reconstructs semantics
      // canonically from authored sources.
      reusableSourceContributions: undefined,
      reusableValidationContributions: undefined,
      reusableDependencyState: undefined,
    };

    if (this.nativeAuthority) {
      // Establish the physical baseline before cold semantic reconstruction. Native authority is
      // the only persisted/restart acceleration boundary; no semantic products are loaded here.
      await this.observeNativeAuthority(canonicalRoot, []);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const opened = await workspace.open(canonicalRoot, admissionOptions);
        if (!opened.ok) return opened;
        const nativeAssetSourcePaths = Object.freeze(assetSourcePaths(opened.snapshot.project));
        const proof = await this.observeNativeAuthority(canonicalRoot, nativeAssetSourcePaths);
        if (semanticObservationDelta(proof).paths.length > 0) {
          // The canonical read raced physical change. Retry from authored sources against the
          // newly observed baseline rather than promoting mixed physical generations.
          continue;
        }
        const session = ResidentProjectWorkspaceSession.fromOpenedWithHost(
          opened,
          {
            fileSystem: this.residentFileSystem,
            createWorkspaceService: this.createSessionWorkspace,
          },
          admittedIdentity,
        );
        const entry: ResidentEntry = {
          canonicalRoot,
          session,
          immutablePinned: false,
          authority: null,
          pendingNativeSemanticPaths: new Set(),
          pendingNativeStructuralChange: false,
          pendingNativeExternalAssetChange: false,
          nativeAssetSourcePaths,
          nativeAssetSourcePathSet: new Set(nativeAssetSourcePaths),
          lastUsedAtMilliseconds: Date.now(),
          portableSnapshot: null,
          pinnedPhysicalAuthority: null,
          pinnedExternalAssets: null,
          pinnedProjectTextSources: null,
        };
        this.sessions.set(canonicalRoot, entry);
        this.bindSnapshot(entry, opened.snapshot);
        return opened;
      }
      throw new Error('Project sources changed continuously during resident Project admission.');
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const opened = await workspace.open(canonicalRoot, admissionOptions);
      if (!opened.ok) return opened;
      const authority = await captureResidentAuthority(this.residentFileSystem, opened.snapshot);
      if (!authority) continue;
      const session = ResidentProjectWorkspaceSession.fromOpenedWithHost(
        opened,
        {
          fileSystem: this.residentFileSystem,
          createWorkspaceService: this.createSessionWorkspace,
        },
        admittedIdentity,
      );
      await session.captureAuthoringFileStamps();
      const entry: ResidentEntry = {
        canonicalRoot,
        session,
        immutablePinned: false,
        authority,
        pendingNativeSemanticPaths: new Set(),
        pendingNativeStructuralChange: false,
        pendingNativeExternalAssetChange: false,
        nativeAssetSourcePaths: Object.freeze([]),
        nativeAssetSourcePathSet: new Set(),
        lastUsedAtMilliseconds: Date.now(),
        portableSnapshot: null,
        pinnedPhysicalAuthority: null,
        pinnedExternalAssets: null,
        pinnedProjectTextSources: null,
      };
      this.sessions.set(canonicalRoot, entry);
      this.bindSnapshot(entry, opened.snapshot);
      return opened;
    }
    return workspace.open(canonicalRoot, options);
  }

  private async reopenResidentEntry(
    entry: ResidentEntry,
    options: ProjectWorkspaceOpenOptions,
  ): Promise<ProjectWorkspaceOpenResult> {
    if (this.nativeAuthority) {
      const currentIdentity = entry.session.generationIdentity();
      entry.session.markResyncNeeded();
      return this.openCold(entry.canonicalRoot, options, {
        sessionEpoch: currentIdentity.sessionEpoch,
        generation: currentIdentity.generation + 1,
      });
    }
    entry.session.invalidateCachedProjectState();
    const reopened = await entry.session.service().open(entry.canonicalRoot, options);
    if (!reopened.ok) return reopened;
    const authority = await captureResidentAuthority(this.residentFileSystem, reopened.snapshot);
    if (!authority) {
      entry.session.markResyncNeeded();
      this.sessions.delete(entry.canonicalRoot);
      return reopened;
    }
    entry.session.adoptOpened(reopened);
    entry.authority = authority;
    this.bindSnapshot(entry, reopened.snapshot);
    await entry.session.captureAuthoringFileStamps();
    return reopened;
  }

  private async reconcileNative(
    entry: ResidentEntry,
    current: SuccessfulOpen,
    options: ProjectWorkspaceOpenOptions,
  ): Promise<ProjectWorkspaceOpenResult> {
    const pendingPaths = new Set([
      ...entry.pendingNativeSemanticPaths,
      ...entry.session.invalidAuthoringSources().filter((path) => path !== '*'),
    ]);
    let structural =
      entry.pendingNativeStructuralChange || entry.session.invalidAuthoringSources().includes('*');
    let observation = await this.observeNativeAuthority(
      entry.canonicalRoot,
      entry.nativeAssetSourcePaths,
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const delta = this.recordNativeObservation(entry, observation);
      delta.paths.forEach((path) => pendingPaths.add(path));
      structural ||= delta.structural;
      if (pendingPaths.size === 0 && !structural) {
        if (entry.pendingNativeExternalAssetChange) {
          const advanced = entry.session.advanceAuthorityGeneration();
          if (!advanced)
            throw new Error(
              'Resident Project generation disappeared during Asset authority advance.',
            );
          entry.pendingNativeExternalAssetChange = false;
          this.bindSnapshot(entry, advanced.snapshot);
          return advanced;
        }
        return current;
      }

      const changedSources = [...pendingPaths].sort();
      let candidate: ProjectWorkspaceOpenResult | null = null;
      if (
        !structural &&
        changedSources.every((path) => Object.hasOwn(current.sourceContributions, path))
      ) {
        entry.session.invalidate(changedSources);
        candidate = await entry.session.service().reconcileExistingSources(current, changedSources);
      }
      if (!candidate) {
        entry.session.invalidate(changedSources);
        const changed = new Set(changedSources);
        const reusableSourceContributions = Object.freeze(
          Object.fromEntries(
            Object.entries(current.sourceContributions).filter(([path]) => !changed.has(path)),
          ),
        );
        candidate = await entry.session.service().open(entry.canonicalRoot, {
          ...options,
          reusableSourceContributions,
          reusableValidationContributions: current.validationContributions,
        });
      }
      if (!candidate.ok) {
        entry.session.recordInvalidAuthoringSources(changedSources);
        return candidate;
      }

      const candidateAssetSourcePaths = assetAuthorityPathsAfterChanges(
        entry.nativeAssetSourcePaths,
        current.snapshot.project,
        candidate.snapshot.project,
        changedSources,
        structural,
      );

      // The proof is intentionally another native observation. It both detects watcher dirtiness
      // and performs the authoritative scan. If it advances the native manifest because of a race,
      // retain every prior pending path: the semantic candidate was never promoted, so the next
      // attempt still starts from the last coherent semantic generation.
      const proof = await this.observeNativeAuthority(
        entry.canonicalRoot,
        candidateAssetSourcePaths,
      );
      const raced = this.recordNativeObservation(entry, proof);
      if (raced.paths.length > 0) {
        raced.paths.forEach((path) => pendingPaths.add(path));
        structural ||= raced.structural;
        observation = proof;
        continue;
      }

      // Native authority classifies every add/remove as structural, so an ordinary changed-source
      // reconciliation can reuse the source-set identity without walking the complete Project.
      const sameSourceSet =
        !structural ||
        (current.snapshot.canonicalSourceFiles.length ===
          candidate.snapshot.canonicalSourceFiles.length &&
          current.snapshot.canonicalSourceFiles.every(
            (path, index) => path === candidate.snapshot.canonicalSourceFiles[index],
          ));
      entry.session.adoptOpened(
        candidate,
        sameSourceSet ? { projectionPaths: changedSources } : {},
      );
      entry.authority = null;
      entry.pendingNativeSemanticPaths.clear();
      entry.pendingNativeStructuralChange = false;
      entry.pendingNativeExternalAssetChange = false;
      entry.nativeAssetSourcePaths = candidateAssetSourcePaths;
      entry.nativeAssetSourcePathSet = new Set(candidateAssetSourcePaths);
      this.bindSnapshot(entry, candidate.snapshot);
      return candidate;
    }

    throw new Error('Project sources changed continuously during resident Project reconciliation.');
  }

  private async reconcile(
    entry: ResidentEntry,
    options: ProjectWorkspaceOpenOptions,
  ): Promise<ProjectWorkspaceOpenResult> {
    return entry.session.runExclusive(async () => {
      if (entry.session.coherenceState() === 'resync-needed')
        return this.reopenResidentEntry(entry, options);
      if (!(await workspaceSettled(this.residentFileSystem, entry.canonicalRoot))) {
        entry.session.markResyncNeeded();
        return this.reopenResidentEntry(entry, options);
      }
      const current = entry.session.openedGeneration();
      if (!current) return this.reopenResidentEntry(entry, options);
      if (this.nativeAuthority) return this.reconcileNative(entry, current, options);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const observed = await this.captureInventory(current.snapshot);
        if (!observed) {
          entry.session.markResyncNeeded();
          return this.reopenResidentEntry(entry, options);
        }
        if (entry.authority && projectSourceInventoriesEqual(entry.authority, observed))
          return current;

        const changes = entry.authority
          ? changedInventoryPaths(entry.authority, observed)
          : { structural: true, paths: current.snapshot.canonicalSourceFiles };
        const canonicalSources = new Set(current.snapshot.canonicalSourceFiles);
        const changedSources = changes.paths.filter((path) => canonicalSources.has(path));
        const onlyNonSemanticChanges = !changes.structural && changedSources.length === 0;
        if (onlyNonSemanticChanges) {
          const proof = await this.captureInventory(current.snapshot);
          if (!proof || !projectSourceInventoriesEqual(observed, proof)) continue;
          entry.authority = proof;
          return current;
        }

        let candidate: ProjectWorkspaceOpenResult | null = null;
        if (!changes.structural && changedSources.length === changes.paths.length) {
          entry.session.invalidate(changedSources);
          candidate = await entry.session
            .service()
            .reconcileExistingSources(current, changedSources);
        }
        if (!candidate) {
          entry.session.invalidate(changes.paths);
          const changed = new Set(changes.paths);
          const reusableSourceContributions = Object.freeze(
            Object.fromEntries(
              Object.entries(current.sourceContributions).filter(([path]) => !changed.has(path)),
            ),
          );
          candidate = await entry.session.service().open(entry.canonicalRoot, {
            ...options,
            reusableSourceContributions,
            reusableValidationContributions: current.validationContributions,
          });
        }
        if (!candidate.ok) {
          entry.session.recordInvalidAuthoringSources(changes.paths);
          return candidate;
        }

        const proof = await this.captureInventory(candidate.snapshot);
        if (!proof || !projectSourceInventoriesEqual(observed, proof)) continue;
        const sameSourceSet =
          current.snapshot.canonicalSourceFiles.length ===
            candidate.snapshot.canonicalSourceFiles.length &&
          current.snapshot.canonicalSourceFiles.every(
            (path, index) => path === candidate.snapshot.canonicalSourceFiles[index],
          );
        entry.session.adoptOpened(
          candidate,
          sameSourceSet ? { projectionPaths: changedSources } : {},
        );
        entry.authority = proof;
        this.bindSnapshot(entry, candidate.snapshot);
        await entry.session.captureAuthoringFileStamps(changes.paths);
        return candidate;
      }

      entry.session.markResyncNeeded();
      return this.reopenResidentEntry(entry, options);
    });
  }

  override async open(
    projectRoot: string,
    options: ProjectWorkspaceOpenOptions = {},
  ): Promise<ProjectWorkspaceOpenResult> {
    const logicalRoot = this.residentFileSystem.resolvePath(projectRoot);
    const canonicalRoot = await this.canonicalProjectRoot(logicalRoot);
    if (!canonicalRoot)
      return this.createSessionWorkspace(this.residentFileSystem).open(logicalRoot, options);

    let entry = this.sessions.get(canonicalRoot);
    if (!entry) {
      const cold = await this.openCold(canonicalRoot, options);
      if (!cold.ok) return cold;
      entry = this.sessions.get(canonicalRoot);
      if (!entry) return cold;
      return this.logicalView(entry, cold, logicalRoot);
    }

    if (entry.immutablePinned) {
      const pinned = entry.session.openedGeneration();
      if (!pinned) throw new Error('Pinned Project generation is unavailable.');
      return this.logicalView(entry, pinned, logicalRoot);
    }

    const opened = await this.reconcile(entry, options);
    if (!opened.ok) return opened;
    entry = this.sessions.get(canonicalRoot) ?? entry;
    return this.logicalView(entry, opened, logicalRoot);
  }

  async openForMutation(
    projectRoot: string,
    options: ProjectWorkspaceOpenOptions = {},
  ): Promise<ProjectWorkspaceOpenResult> {
    const logicalRoot = this.residentFileSystem.resolvePath(projectRoot);
    const canonicalRoot = await this.canonicalProjectRoot(logicalRoot);
    if (!canonicalRoot)
      return this.createSessionWorkspace(this.residentFileSystem).open(logicalRoot, options);

    let entry = this.sessions.get(canonicalRoot);
    if (!entry) {
      const cold = await this.openCold(canonicalRoot, options);
      if (!cold.ok) return cold;
      entry = this.sessions.get(canonicalRoot);
      if (!entry) return cold;
      return this.logicalView(entry, cold, logicalRoot);
    }

    if (entry.immutablePinned)
      throw new ProjectWorkspaceMutationError(
        'WORKSPACE_REVISION_CONFLICT',
        'Pinned disposable Project generations are immutable.',
      );

    const reconciled = await this.reconcile(entry, options);
    if (reconciled.ok) {
      entry = this.sessions.get(canonicalRoot) ?? entry;
      return this.logicalView(entry, reconciled, logicalRoot);
    }
    if (entry.session.coherenceState() !== 'invalid') return reconciled;
    const coherent = entry.session.openedGeneration();
    return coherent ? this.logicalView(entry, coherent, logicalRoot) : reconciled;
  }

  async openForRead(
    projectRoot: string,
    requiredSemanticPaths: readonly string[],
    options: ProjectWorkspaceOpenOptions = {},
  ): Promise<ProjectWorkspaceOpenResult> {
    const logicalRoot = this.residentFileSystem.resolvePath(projectRoot);
    const canonicalRoot = await this.canonicalProjectRoot(logicalRoot);
    if (!canonicalRoot)
      return this.createSessionWorkspace(this.residentFileSystem).open(logicalRoot, options);

    let entry = this.sessions.get(canonicalRoot);
    if (!entry) {
      const cold = await this.openCold(canonicalRoot, options);
      if (!cold.ok) return cold;
      entry = this.sessions.get(canonicalRoot);
      return entry ? this.logicalView(entry, cold, logicalRoot) : cold;
    }
    if (entry.immutablePinned) {
      const pinned = entry.session.openedGeneration();
      if (!pinned) throw new Error('Pinned Project generation is unavailable.');
      return this.logicalView(entry, pinned, logicalRoot);
    }

    const reconciled = await this.reconcile(entry, options);
    if (reconciled.ok) {
      entry = this.sessions.get(canonicalRoot) ?? entry;
      return this.logicalView(entry, reconciled, logicalRoot);
    }
    if (entry.session.coherenceState() !== 'invalid') return reconciled;
    const invalidBlock = entry.session.invalidSourceBlockForSemanticPaths(requiredSemanticPaths);
    if (invalidBlock) return reconciled;
    const coherent = entry.session.openedGeneration();
    return coherent ? this.logicalView(entry, coherent, logicalRoot) : reconciled;
  }

  async captureScopedReadAuthority(
    projectRoot: string,
    requiredSemanticPaths: readonly string[],
  ): Promise<ScopedReadAuthorityToken | null> {
    const canonicalRoot = await this.canonicalProjectRoot(
      this.residentFileSystem.resolvePath(projectRoot),
    );
    if (!canonicalRoot) return null;
    const entry = this.sessions.get(canonicalRoot);
    if (this.nativeAuthority) {
      const assetPaths = entry?.nativeAssetSourcePaths ?? Object.freeze([]);
      const assetPathSet = entry?.nativeAssetSourcePathSet ?? new Set<string>();
      const observation = await this.observeNativeAuthority(canonicalRoot, assetPaths, true);
      if (entry) this.recordNativeObservation(entry, observation);
      return Object.freeze({
        canonicalRoot,
        requiredSemanticPaths: Object.freeze([...requiredSemanticPaths]),
        authoritySignature: scopedAuthoritySignature(
          observation,
          requiredSemanticPaths,
          assetPathSet,
        ),
        relevantDeltaPaths: scopedAuthorityRelevantDeltaPaths(
          observation,
          requiredSemanticPaths,
          assetPathSet,
        ),
      });
    }
    if (!entry) return null;
    const inventory = await this.captureInventory(entry.session.snapshot());
    if (!inventory) return null;
    const assetPathSet = new Set(assetSourcePaths(entry.session.project()));
    return Object.freeze({
      canonicalRoot,
      requiredSemanticPaths: Object.freeze([...requiredSemanticPaths]),
      authoritySignature: JSON.stringify(
        inventory.entries
          .filter((candidate) =>
            physicalPathRequiredBySemanticPaths(
              candidate.path,
              requiredSemanticPaths,
              assetPathSet,
            ),
          )
          .map((candidate) => [candidate.path, candidate.byteSize, candidate.mtimeNanoseconds]),
      ),
      relevantDeltaPaths: Object.freeze([]),
    });
  }

  async verifyScopedReadAuthority(token: ScopedReadAuthorityToken): Promise<boolean> {
    const current = await this.captureScopedReadAuthority(
      token.canonicalRoot,
      token.requiredSemanticPaths,
    );
    return (
      current !== null &&
      current.relevantDeltaPaths.length === 0 &&
      current.authoritySignature === token.authoritySignature
    );
  }

  private changedCanonicalPaths(
    before: LoadedProjectWorkspaceSnapshot,
    after: LoadedProjectWorkspaceSnapshot,
  ): readonly string[] {
    return [...new Set([...before.canonicalSourceFiles, ...after.canonicalSourceFiles])]
      .filter(
        (path) =>
          (before.fileRevisions[path]?.contentHash ?? 'absent') !==
          (after.fileRevisions[path]?.contentHash ?? 'absent'),
      )
      .sort();
  }

  private async proveChangedFiles(
    entry: ResidentEntry,
    opened: SuccessfulOpen,
    changedCanonicalPaths: readonly string[],
  ): Promise<boolean> {
    for (const relativePath of changedCanonicalPaths) {
      const expected = opened.snapshot.fileRevisions[relativePath];
      const absolute = this.residentFileSystem.joinPath(entry.canonicalRoot, relativePath);
      if (!expected) {
        if ((await this.residentFileSystem.inspect(absolute)) !== 'missing') return false;
        continue;
      }
      try {
        const actual = await this.residentFileSystem.readFileRevision(absolute);
        if (actual.byteSize !== expected.byteSize || actual.contentHash !== expected.contentHash)
          return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private async proveExtraTransactionTargets(
    entry: ResidentEntry,
    options: ProjectWorkspaceWriteOptions,
  ): Promise<boolean> {
    for (const target of options.extraTargets ?? []) {
      const absolute = this.residentFileSystem.joinPath(entry.canonicalRoot, target.path);
      if (target.operation === 'delete') {
        if ((await this.residentFileSystem.inspect(absolute)) !== 'missing') return false;
        continue;
      }
      const bytes = target.bytes;
      if (!bytes) return false;
      try {
        const actual = await this.residentFileSystem.readFileRevision(absolute);
        if (
          actual.byteSize !== bytes.byteLength ||
          actual.contentHash !== (await sha256PrefixedBytes(bytes))
        )
          return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private async adoptCommittedTransaction(
    entry: ResidentEntry,
    before: SuccessfulOpen,
    prewriteAuthority: ProjectSourceInventory | null,
    written: ProjectWorkspaceWriteResult,
    options: ProjectWorkspaceWriteOptions,
    candidate: SuccessfulOpen,
    changedCanonicalPaths: readonly string[],
  ): Promise<void> {
    if (candidate.snapshot.workspaceRevision !== written.snapshot.workspaceRevision) {
      entry.session.markResyncNeeded();
      throw new ProjectWorkspaceMutationError(
        'WORKSPACE_REVISION_CONFLICT',
        'The committed Project generation did not match the admitted mutation candidate.',
      );
    }

    let fallbackProof: ProjectSourceInventory | null = null;
    if (this.nativeAuthority) {
      const candidateAssetSourcePaths = assetAuthorityPathsAfterChanges(
        entry.nativeAssetSourcePaths,
        before.snapshot.project,
        candidate.snapshot.project,
        changedCanonicalPaths,
        before.snapshot.canonicalSourceFiles.length !==
          candidate.snapshot.canonicalSourceFiles.length,
      );
      let observation: ResidentProjectAuthorityObservation;
      try {
        certificationDelay('NOVELTEA_CLI_CERTIFICATION_BEFORE_MUTATION_PROOF_DELAY_MS');
        observation = await this.observeNativeAuthority(
          entry.canonicalRoot,
          candidateAssetSourcePaths,
        );
      } catch (error) {
        entry.session.markResyncNeeded();
        throw error;
      }
      const delta = this.recordNativeObservation(entry, observation);
      const expectedSemanticPaths = changedCanonicalPaths.filter(isResidentSemanticSourcePath);
      if (
        delta.paths.length !== expectedSemanticPaths.length ||
        delta.paths.some((path, index) => path !== expectedSemanticPaths[index]) ||
        !(await this.proveChangedFiles(entry, candidate, changedCanonicalPaths)) ||
        !(await this.proveExtraTransactionTargets(entry, options))
      ) {
        entry.session.markResyncNeeded();
        throw new ProjectWorkspaceMutationError(
          'WORKSPACE_REVISION_CONFLICT',
          'Project sources changed while proving the committed mutation.',
          delta.paths.find((path) => !expectedSemanticPaths.includes(path)),
        );
      }
      entry.nativeAssetSourcePaths = candidateAssetSourcePaths;
      entry.nativeAssetSourcePathSet = new Set(candidateAssetSourcePaths);
    } else {
      if (!prewriteAuthority)
        throw new Error('Resident mutation fallback authority is unavailable.');
      const observed = await this.captureInventory(written.snapshot);
      if (!observed) {
        entry.session.markResyncNeeded();
        throw new ProjectWorkspaceMutationError(
          'WORKSPACE_REVISION_CONFLICT',
          'Project sources could not be proven after the committed mutation.',
        );
      }
      const changes = changedInventoryPaths(prewriteAuthority, observed);
      const transactionPaths = new Set([
        ...changedCanonicalPaths,
        ...(options.extraTargets ?? []).map((target) => target.path),
      ]);
      if (
        changes.paths.some((path) => !transactionPaths.has(path)) ||
        !(await this.proveChangedFiles(entry, candidate, changedCanonicalPaths))
      ) {
        entry.session.markResyncNeeded();
        throw new ProjectWorkspaceMutationError(
          'WORKSPACE_REVISION_CONFLICT',
          'Project sources changed while proving the committed mutation.',
          changes.paths.find((path) => !transactionPaths.has(path)),
        );
      }
      const proof = await this.captureInventory(candidate.snapshot);
      if (!proof || !projectSourceInventoriesEqual(observed, proof)) {
        entry.session.markResyncNeeded();
        throw new ProjectWorkspaceMutationError(
          'WORKSPACE_REVISION_CONFLICT',
          'Project sources changed while proving the committed mutation.',
        );
      }
      fallbackProof = proof;
      entry.authority = mergeInventoryPaths(entry.authority ?? prewriteAuthority, proof, [
        ...new Set([...changes.paths, ...changedCanonicalPaths]),
      ]);
    }

    const sameSourceSet =
      before.snapshot.canonicalSourceFiles.length ===
        candidate.snapshot.canonicalSourceFiles.length &&
      before.snapshot.canonicalSourceFiles.every(
        (path, index) => path === candidate.snapshot.canonicalSourceFiles[index],
      );
    entry.session.adoptOpened(candidate, {
      preserveInvalidOverlay: entry.session.invalidAuthoringSources().length > 0,
      ...(sameSourceSet ? { projectionPaths: changedCanonicalPaths } : {}),
    });
    if (this.nativeAuthority) {
      entry.pendingNativeSemanticPaths.clear();
      entry.pendingNativeStructuralChange = false;
      entry.pendingNativeExternalAssetChange = false;
      entry.authority = null;
    } else if (!fallbackProof) {
      entry.authority = prewriteAuthority;
    }
    this.bindSnapshot(entry, candidate.snapshot);
    await entry.session.captureAuthoringFileStamps(changedCanonicalPaths);
  }

  override async write(
    ...args: Parameters<ProjectWorkspaceService['write']>
  ): Promise<ProjectWorkspaceWriteResult> {
    const [projectRoot, expectedRevision, project, editorState, sourcePathOverrides] = args;
    const options = args[5] ?? {};
    const logicalRoot = this.residentFileSystem.resolvePath(projectRoot);
    const canonicalRoot = await this.canonicalProjectRoot(logicalRoot);
    const entry = canonicalRoot ? this.sessions.get(canonicalRoot) : undefined;
    if (!entry)
      return super.write(
        projectRoot,
        expectedRevision,
        project,
        editorState,
        sourcePathOverrides,
        options,
      );
    if (entry.immutablePinned)
      throw new ProjectWorkspaceMutationError(
        'WORKSPACE_REVISION_CONFLICT',
        'Pinned disposable Project generations are immutable.',
      );

    return entry.session.runExclusive(async () => {
      const before = entry.session.openedGeneration();
      if (!before) {
        entry.session.markResyncNeeded();
        return entry.session
          .service()
          .write(
            entry.canonicalRoot,
            expectedRevision,
            project,
            editorState,
            sourcePathOverrides,
            options,
          );
      }

      const invalidSourceBlock = entry.session.invalidSourceBlockForMutation(
        options.saveUnitIds ?? [],
        options.affectedPaths ?? ['/'],
      );
      if (invalidSourceBlock)
        throw new ProjectWorkspaceMutationError(
          'WORKSPACE_INVALID_SOURCE_DEPENDENCY',
          `Project source ${invalidSourceBlock.files.map((file) => `'${file}'`).join(', ')} is invalid on disk and overlaps this mutation.`,
        );

      let prewriteAuthority: ProjectSourceInventory | null = null;
      if (this.nativeAuthority) {
        const observation = await this.observeNativeAuthority(
          entry.canonicalRoot,
          entry.nativeAssetSourcePaths,
        );
        this.recordNativeObservation(entry, observation);
        const invalidOverlayPaths = new Set(entry.session.invalidAuthoringSources());
        const unresolvedPendingPath = [...entry.pendingNativeSemanticPaths]
          .sort()
          .find((path) => !invalidOverlayPaths.has(path));
        if (unresolvedPendingPath) {
          throw new ProjectWorkspaceMutationError(
            'WORKSPACE_REVISION_CONFLICT',
            `Project source '${unresolvedPendingPath}' changed before the mutation could commit.`,
            unresolvedPendingPath,
          );
        }
      } else {
        prewriteAuthority = await this.captureInventory(before.snapshot);
        if (!prewriteAuthority) {
          entry.session.markResyncNeeded();
          throw new ProjectWorkspaceMutationError(
            'WORKSPACE_REVISION_CONFLICT',
            'Project sources could not be proven before the mutation could commit.',
          );
        }
      }

      let admittedCandidate: SuccessfulOpen | null = null;
      let changedCanonicalPaths: readonly string[] = [];
      let committed = false;
      try {
        const written = await entry.session
          .service()
          .write(entry.canonicalRoot, expectedRevision, project, editorState, sourcePathOverrides, {
            ...options,
            preflightSnapshot: before.snapshot,
            refreshAfterCommit: false,
            admitCandidateBeforeCommit: async (snapshot) => {
              await options.admitCandidateBeforeCommit?.(snapshot);
              changedCanonicalPaths = this.changedCanonicalPaths(before.snapshot, snapshot);
              const candidate = entry.session
                .service()
                .advanceCommittedSnapshot(before, snapshot, changedCanonicalPaths);
              if (!candidate?.ok)
                throw new Error('Project mutation candidate could not be admitted.');
              admittedCandidate = candidate;
            },
          });
        committed = true;
        if (!admittedCandidate)
          throw new Error('Project mutation did not produce an admitted candidate generation.');
        await entry.session.service().writeEditorLocalState(entry.canonicalRoot, editorState);
        await this.adoptCommittedTransaction(
          entry,
          before,
          prewriteAuthority,
          written,
          options,
          admittedCandidate,
          changedCanonicalPaths,
        );
        return written;
      } catch (error) {
        if (committed) entry.session.markResyncNeeded();
        throw error;
      }
    });
  }

  async reconcileAfterOpaqueWrite(projectRoot: string): Promise<void> {
    const canonicalRoot = await this.canonicalProjectRoot(
      this.residentFileSystem.resolvePath(projectRoot),
    );
    const entry = canonicalRoot ? this.sessions.get(canonicalRoot) : undefined;
    if (!entry) return;
    if (entry.immutablePinned) return;

    const currentIdentity = entry.session.generationIdentity();
    entry.session.markResyncNeeded();
    // Opaque effects may include local editor state or Project source ownership changes that are
    // intentionally outside the resident inventory. Re-admit from disk instead of guessing which
    // parts of the prior generation remain valid, while retaining the owner's monotonic identity.
    await this.openCold(
      entry.canonicalRoot,
      {},
      {
        sessionEpoch: currentIdentity.sessionEpoch,
        generation: currentIdentity.generation + 1,
      },
    );
  }

  async hasResidentSession(projectRoot: string): Promise<boolean> {
    const canonicalRoot = await this.canonicalProjectRoot(
      this.residentFileSystem.resolvePath(projectRoot),
    );
    return canonicalRoot !== null && this.sessions.has(canonicalRoot);
  }

  residentSessionCount(): number {
    return this.sessions.size;
  }

  async residentGenerationIdentity(
    projectRoot: string,
  ): Promise<ResidentProjectGenerationIdentity | null> {
    const canonicalRoot = await this.canonicalProjectRoot(
      this.residentFileSystem.resolvePath(projectRoot),
    );
    const entry = canonicalRoot ? this.sessions.get(canonicalRoot) : undefined;
    return entry?.session.generationIdentity() ?? null;
  }

  residentGenerationIdentities(): readonly Readonly<{
    projectRoot: string;
    identity: ResidentProjectGenerationIdentity;
  }>[] {
    return [...this.sessions.values()].map((entry) => ({
      projectRoot: entry.canonicalRoot,
      identity: entry.session.generationIdentity(),
    }));
  }

  async preparePortableSnapshot(
    projectRoot: string,
  ): Promise<PreparedPortableResidentProjectSnapshot | null> {
    const canonicalRoot = await this.canonicalProjectRoot(
      this.residentFileSystem.resolvePath(projectRoot),
    );
    const entry = canonicalRoot ? this.sessions.get(canonicalRoot) : undefined;
    if (!entry || entry.session.coherenceState() !== 'coherent') return null;
    return entry.session.runExclusive(async () => {
      let opened = entry.session.openedGeneration();
      if (!opened) return null;

      let externalAssets: PortableResidentProjectSnapshot['externalAssets'] = [];
      let physicalAuthority: PortableResidentProjectSnapshot['physicalAuthority'] = [];
      if (this.nativeAuthority) {
        let proof = await this.observeNativeAuthority(
          entry.canonicalRoot,
          entry.nativeAssetSourcePaths,
          true,
        );
        const delta = this.recordNativeObservation(entry, proof);
        if (
          delta.paths.length > 0 ||
          entry.pendingNativeSemanticPaths.size > 0 ||
          entry.pendingNativeStructuralChange ||
          entry.pendingNativeExternalAssetChange
        ) {
          const reconciled = await this.reconcileNative(entry, opened, {});
          if (!reconciled.ok || entry.session.coherenceState() !== 'coherent') return null;
          opened = reconciled;

          // Snapshot maintenance may be the operation that first consumed a watcher delta. Reprove
          // after reconciling that pending state so the serialized semantic generation and the
          // separately retained native authority checkpoint describe the same physical baseline.
          proof = await this.observeNativeAuthority(
            entry.canonicalRoot,
            entry.nativeAssetSourcePaths,
            true,
          );
          const postReconcileDelta = this.recordNativeObservation(entry, proof);
          if (
            postReconcileDelta.paths.length > 0 ||
            entry.pendingNativeSemanticPaths.size > 0 ||
            entry.pendingNativeStructuralChange
          )
            return null;
        }
        if (entry.pendingNativeExternalAssetChange) {
          const advanced = entry.session.advanceAuthorityGeneration();
          if (!advanced) return null;
          entry.pendingNativeExternalAssetChange = false;
          this.bindSnapshot(entry, advanced.snapshot);
          opened = advanced;
        }
        physicalAuthority = Object.freeze([...proof.manifest.entries]);
        externalAssets = Object.freeze(
          proof.manifest.entries.filter((candidate) =>
            entry.nativeAssetSourcePathSet.has(candidate.path),
          ),
        );
      } else if (entry.authority) {
        const assetPaths = new Set(assetSourcePaths(opened.snapshot.project));
        externalAssets = Object.freeze(
          entry.authority.entries
            .filter((candidate) => assetPaths.has(candidate.path))
            .map((candidate) => ({
              path: candidate.path,
              byteSize: candidate.byteSize,
              mtimeNanoseconds:
                candidate.mtimeNanoseconds === null
                  ? null
                  : (candidate.mtimeNanoseconds?.toString() ?? null),
            })),
        );
        physicalAuthority = Object.freeze(
          entry.authority.entries.map((candidate) => ({
            path: candidate.path,
            byteSize: candidate.byteSize,
            mtimeNanoseconds: candidate.mtimeNanoseconds,
          })),
        );
      }

      const projectTextSources: Record<string, PortableResidentProjectTextSource> = {};
      for (const relativePath of portableProjectTextSourcePaths(opened.snapshot.project)) {
        const contribution = opened.sourceContributions[relativePath];
        if (contribution?.kind === 'text') {
          projectTextSources[relativePath] = Object.freeze({
            contentHash: contribution.contentHash,
            text: contribution.text,
          });
          continue;
        }
        try {
          const bytes = await this.residentFileSystem.readBytes(
            this.residentFileSystem.joinPath(entry.canonicalRoot, relativePath),
          );
          projectTextSources[relativePath] = Object.freeze({
            contentHash: await sha256PrefixedBytes(bytes),
            text: new TextDecoder().decode(bytes).replace(/^\uFEFF/u, ''),
          });
        } catch {
          return null;
        }
      }
      if (this.nativeAuthority) {
        const postSourceProof = await this.observeNativeAuthority(
          entry.canonicalRoot,
          entry.nativeAssetSourcePaths,
          true,
        );
        this.recordNativeObservation(entry, postSourceProof);
        if (!postSourceProof.unchanged) return null;
        physicalAuthority = Object.freeze([...postSourceProof.manifest.entries]);
        externalAssets = Object.freeze(
          postSourceProof.manifest.entries.filter((candidate) =>
            entry.nativeAssetSourcePathSet.has(candidate.path),
          ),
        );
      }

      const identity = entry.session.generationIdentity();
      if (
        entry.portableSnapshot?.identity.sessionEpoch === identity.sessionEpoch &&
        entry.portableSnapshot.identity.generation === identity.generation
      )
        return entry.portableSnapshot;

      const snapshot: PortableResidentProjectSnapshot = {
        version: PORTABLE_RESIDENT_PROJECT_SNAPSHOT_VERSION,
        identity,
        snapshot: opened.snapshot,
        editorState: opened.editorState,
        diagnostics: opened.diagnostics,
        sourceContributions: opened.sourceContributions,
        validationContributions: opened.validationContributions,
        validationWork: opened.validationWork,
        sourceWork: opened.sourceWork,
        externalAssets,
        physicalAuthority,
        projectTextSources: Object.freeze(projectTextSources),
      };
      const ownerMetadata: PortableResidentProjectOwnerMetadata = {
        version: PORTABLE_RESIDENT_PROJECT_SNAPSHOT_VERSION,
        canonicalRoot: entry.canonicalRoot,
        nativeAssetSourcePaths: entry.nativeAssetSourcePaths,
      };
      const prepared = Object.freeze({
        projectRoot: entry.canonicalRoot,
        identity,
        snapshotText: JSON.stringify(snapshot),
        ownerMetadataText: JSON.stringify(ownerMetadata),
      });
      entry.portableSnapshot = prepared;
      return prepared;
    });
  }

  async preparePortableSnapshots(): Promise<readonly PreparedPortableResidentProjectSnapshot[]> {
    const prepared: PreparedPortableResidentProjectSnapshot[] = [];
    for (const entry of this.sessions.values()) {
      const snapshot = await this.preparePortableSnapshot(entry.canonicalRoot);
      if (snapshot) prepared.push(snapshot);
    }
    return prepared;
  }

  async rehydratePortableSnapshot(
    projectRoot: string,
    snapshotText: string,
    ownerMetadataText: string,
  ): Promise<boolean> {
    const logicalRoot = this.residentFileSystem.resolvePath(projectRoot);
    const canonicalRoot = await this.canonicalProjectRoot(logicalRoot);
    if (!canonicalRoot || this.sessions.has(canonicalRoot)) return false;

    let ownerMetadata: PortableResidentProjectOwnerMetadata;
    try {
      ownerMetadata = JSON.parse(ownerMetadataText) as PortableResidentProjectOwnerMetadata;
    } catch {
      return false;
    }
    if (
      ownerMetadata?.version !== PORTABLE_RESIDENT_PROJECT_SNAPSHOT_VERSION ||
      ownerMetadata.canonicalRoot !== canonicalRoot ||
      !Array.isArray(ownerMetadata.nativeAssetSourcePaths) ||
      ownerMetadata.nativeAssetSourcePaths.some((path) => typeof path !== 'string') ||
      !(await this.hydratePortableSnapshot(projectRoot, snapshotText))
    )
      return false;
    const entry = this.sessions.get(canonicalRoot);
    if (!entry) return false;
    entry.immutablePinned = false;
    entry.nativeAssetSourcePaths = Object.freeze([...ownerMetadata.nativeAssetSourcePaths]);
    entry.nativeAssetSourcePathSet = new Set(entry.nativeAssetSourcePaths);
    entry.portableSnapshot = Object.freeze({
      projectRoot: canonicalRoot,
      identity: entry.session.generationIdentity(),
      snapshotText,
      ownerMetadataText,
    });
    return true;
  }

  async hydratePortableSnapshot(projectRoot: string, snapshotText: string): Promise<boolean> {
    const logicalRoot = this.residentFileSystem.resolvePath(projectRoot);
    const canonicalRoot = await this.canonicalProjectRoot(logicalRoot);
    if (!canonicalRoot || this.sessions.has(canonicalRoot)) return false;

    let portable: PortableResidentProjectSnapshot;
    try {
      portable = JSON.parse(snapshotText) as PortableResidentProjectSnapshot;
    } catch {
      return false;
    }
    if (
      portable?.version !== PORTABLE_RESIDENT_PROJECT_SNAPSHOT_VERSION ||
      portable.snapshot?.snapshotKind !== 'loaded' ||
      portable.snapshot.projectRoot !== canonicalRoot ||
      portable.snapshot.manifestPath !==
        this.residentFileSystem.joinPath(canonicalRoot, 'project.json') ||
      !Number.isSafeInteger(portable.identity?.sessionEpoch) ||
      portable.identity.sessionEpoch <= 0 ||
      !Number.isSafeInteger(portable.identity?.generation) ||
      portable.identity.generation <= 0 ||
      !Array.isArray(portable.diagnostics) ||
      !portable.sourceContributions ||
      !Array.isArray(portable.validationContributions) ||
      !portable.validationWork ||
      !portable.sourceWork ||
      !portableAuthorityEntriesValid(portable.externalAssets) ||
      !portableAuthorityEntriesValid(portable.physicalAuthority) ||
      !portableTextSourcesValid(portable.projectTextSources)
    )
      return false;

    try {
      const opened: SuccessfulOpen = {
        ok: true,
        snapshot: portable.snapshot,
        diagnostics: portable.diagnostics,
        editorState: portable.editorState,
        repairs: [],
        contentProject: stripEditorProjectState(portable.snapshot.project),
        savedContentProject: stripEditorProjectState(portable.snapshot.project),
        sourceContributions: portable.sourceContributions,
        validationContributions: portable.validationContributions,
        validationWork: portable.validationWork,
        sourceWork: portable.sourceWork,
      };
      const session = ResidentProjectWorkspaceSession.fromOpenedWithHost(
        opened,
        {
          fileSystem: this.residentFileSystem,
          createWorkspaceService: this.createSessionWorkspace,
        },
        portable.identity,
      );
      const entry: ResidentEntry = {
        canonicalRoot,
        session,
        immutablePinned: true,
        authority: null,
        pendingNativeSemanticPaths: new Set(),
        pendingNativeStructuralChange: false,
        pendingNativeExternalAssetChange: false,
        nativeAssetSourcePaths: Object.freeze([]),
        nativeAssetSourcePathSet: new Set(),
        lastUsedAtMilliseconds: Date.now(),
        portableSnapshot: null,
        pinnedPhysicalAuthority: Object.freeze([...portable.physicalAuthority]),
        pinnedExternalAssets: Object.freeze([...portable.externalAssets]),
        pinnedProjectTextSources: Object.freeze({ ...portable.projectTextSources }),
      };
      this.sessions.set(canonicalRoot, entry);
      this.bindSnapshot(entry, opened.snapshot);
      return true;
    } catch {
      return false;
    }
  }

  async pinnedPortableInputs(
    projectRoot: string,
  ): Promise<PinnedPortableResidentProjectInputs | null> {
    const canonicalRoot = await this.canonicalProjectRoot(
      this.residentFileSystem.resolvePath(projectRoot),
    );
    const entry = canonicalRoot ? this.sessions.get(canonicalRoot) : undefined;
    if (
      !entry?.immutablePinned ||
      !entry.pinnedPhysicalAuthority ||
      !entry.pinnedExternalAssets ||
      !entry.pinnedProjectTextSources
    )
      return null;
    const opened = entry.session.openedGeneration();
    if (!opened) return null;
    return Object.freeze({
      sourceContributions: opened.sourceContributions,
      physicalAuthority: entry.pinnedPhysicalAuthority,
      externalAssets: entry.pinnedExternalAssets,
      projectTextSources: entry.pinnedProjectTextSources,
    });
  }

  async reconcileResidentSessions(): Promise<number> {
    let advanced = 0;
    for (const entry of Array.from(this.sessions.values())) {
      const before = entry.session.generationIdentity();
      const result = await this.reconcile(entry, {});
      if (!result.ok) {
        advanced += 1;
        continue;
      }
      const after =
        this.sessions.get(entry.canonicalRoot)?.session.generationIdentity() ??
        entry.session.generationIdentity();
      if (before.sessionEpoch !== after.sessionEpoch || before.generation !== after.generation)
        advanced += 1;
    }
    return advanced;
  }

  evictIdleSessions(maxIdleMilliseconds: number, nowMilliseconds = Date.now()): number {
    if (!Number.isFinite(maxIdleMilliseconds) || maxIdleMilliseconds <= 0) return 0;
    let evicted = 0;
    for (const [canonicalRoot, entry] of this.sessions) {
      if (nowMilliseconds - entry.lastUsedAtMilliseconds < maxIdleMilliseconds) continue;
      entry.session.markResyncNeeded();
      this.sessions.delete(canonicalRoot);
      this.installedNativeAssetPaths.delete(canonicalRoot);
      this.nativeAuthority?.release(canonicalRoot);
      evicted += 1;
    }
    return evicted;
  }

  async verifyReadAuthority(snapshot: LoadedProjectWorkspaceSnapshot): Promise<boolean> {
    const binding = this.snapshotBindings.get(snapshot);
    if (!binding) return true;
    if (!binding.entry.session.isGeneration(binding.generation)) return false;
    if (this.nativeAuthority) {
      const observation = await this.observeNativeAuthority(
        binding.entry.canonicalRoot,
        binding.entry.nativeAssetSourcePaths,
      );
      const delta = this.recordNativeObservation(binding.entry, observation);
      return observation.unchanged && delta.paths.length === 0;
    }
    const current = await this.captureInventory(binding.canonicalSnapshot);
    return (
      current !== null &&
      binding.entry.authority !== null &&
      projectSourceInventoriesEqual(binding.entry.authority, current)
    );
  }

  override preflightCompiledArtifact(snapshot: ProjectWorkspaceSnapshot) {
    const binding = this.snapshotBindings.get(snapshot);
    return binding
      ? binding.entry.session.service().preflightCompiledArtifact(binding.canonicalSnapshot)
      : super.preflightCompiledArtifact(snapshot);
  }

  override publishCompiledArtifact(snapshot: ProjectWorkspaceSnapshot) {
    const binding = this.snapshotBindings.get(snapshot);
    return binding
      ? binding.entry.session.service().publishCompiledArtifact(binding.canonicalSnapshot)
      : super.publishCompiledArtifact(snapshot);
  }

  override buildDependencyGraph(snapshot: ProjectWorkspaceSnapshot) {
    const binding = this.snapshotBindings.get(snapshot);
    return binding
      ? binding.entry.session.service().buildDependencyGraph(binding.canonicalSnapshot)
      : super.buildDependencyGraph(snapshot);
  }

  override buildDependencyGraphAnalysis(
    snapshot: ProjectWorkspaceSnapshot,
  ): Promise<ProjectWorkspaceDependencyAnalysis> {
    const binding = this.snapshotBindings.get(snapshot);
    return binding
      ? binding.entry.session.service().buildDependencyGraphAnalysis(binding.canonicalSnapshot)
      : super.buildDependencyGraphAnalysis(snapshot);
  }

  override buildDependencyGraphWithSources(snapshot: ProjectWorkspaceSnapshot) {
    const binding = this.snapshotBindings.get(snapshot);
    return binding
      ? binding.entry.session.service().buildDependencyGraphWithSources(binding.canonicalSnapshot)
      : super.buildDependencyGraphWithSources(snapshot);
  }
}
