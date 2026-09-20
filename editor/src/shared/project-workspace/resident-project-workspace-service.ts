import {
  captureProjectSourceInventory,
  projectSourceInventoriesEqual,
  type ProjectSourceDiscoveryScope,
  type ProjectSourceInventory,
} from '../project-source-inventory';
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
import { ResidentProjectWorkspaceSession } from './resident-project-workspace-session';

export type ResidentProjectWorkspaceServiceFactory = (
  fileSystem: ProjectWorkspaceFileSystem,
) => ProjectWorkspaceService;

const residentDiscoveryScopes: readonly ProjectSourceDiscoveryScope[] = Object.freeze([
  { root: 'records', extensions: ['.json', '.lua', '.rcss', '.rml'], excludedPrefixes: [] },
  { root: 'scripts', extensions: ['.lua'], excludedPrefixes: [] },
  { root: 'i18n', extensions: ['.json'], excludedPrefixes: [] },
]);

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

type ResidentEntry = {
  readonly canonicalRoot: string;
  readonly session: ResidentProjectWorkspaceSession;
  authority: ProjectSourceInventory;
  lastUsedAtMilliseconds: number;
};

type SnapshotBinding = Readonly<{
  entry: ResidentEntry;
  canonicalSnapshot: LoadedProjectWorkspaceSnapshot;
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
  private readonly snapshotBindings = new WeakMap<ProjectWorkspaceSnapshot, SnapshotBinding>();

  constructor(
    private readonly residentFileSystem: ProjectWorkspaceFileSystem,
    private readonly createSessionWorkspace: ResidentProjectWorkspaceServiceFactory = (
      fileSystem,
    ) => new ProjectWorkspaceService(fileSystem),
  ) {
    super(residentFileSystem);
  }

  private captureInventory(
    snapshot: LoadedProjectWorkspaceSnapshot,
  ): Promise<ProjectSourceInventory | null> {
    return captureResidentInventory(this.residentFileSystem, snapshot);
  }

  private bindSnapshot(entry: ResidentEntry, snapshot: LoadedProjectWorkspaceSnapshot): void {
    entry.lastUsedAtMilliseconds = Date.now();
    this.snapshotBindings.set(snapshot, { entry, canonicalSnapshot: snapshot });
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
    this.snapshotBindings.set(snapshot, { entry, canonicalSnapshot: opened.snapshot });
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
  ): Promise<ProjectWorkspaceOpenResult> {
    const workspace = this.createSessionWorkspace(this.residentFileSystem);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const opened = await workspace.open(canonicalRoot, options);
      if (!opened.ok) return opened;
      const authority = await captureResidentAuthority(this.residentFileSystem, opened.snapshot);
      if (!authority) continue;
      const session = ResidentProjectWorkspaceSession.fromOpenedWithHost(opened, {
        fileSystem: this.residentFileSystem,
        createWorkspaceService: this.createSessionWorkspace,
      });
      await session.captureAuthoringFileStamps();
      const entry: ResidentEntry = {
        canonicalRoot,
        session,
        authority,
        lastUsedAtMilliseconds: Date.now(),
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

  private async reconcile(
    entry: ResidentEntry,
    options: ProjectWorkspaceOpenOptions,
  ): Promise<ProjectWorkspaceOpenResult> {
    return entry.session.runExclusive(async () => {
      const current = entry.session.openedGeneration();
      if (!current) return this.reopenResidentEntry(entry, options);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const observed = await this.captureInventory(current.snapshot);
        if (!observed) {
          entry.session.markResyncNeeded();
          return this.reopenResidentEntry(entry, options);
        }
        if (projectSourceInventoriesEqual(entry.authority, observed)) return current;

        const changes = changedInventoryPaths(entry.authority, observed);
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
        if (!changes.structural && changedSources.length === changes.paths.length)
          candidate = await entry.session
            .service()
            .reconcileExistingSources(current, changedSources);
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
        if (!proof) continue;
        const observedByPath = inventoryByPath(observed);
        const proofByPath = inventoryByPath(proof);
        const raced = changes.paths.some((path) => {
          const before = observedByPath.get(path);
          const after = proofByPath.get(path);
          return (
            before === undefined ||
            after === undefined ||
            before.byteSize !== after.byteSize ||
            before.mtimeNanoseconds !== after.mtimeNanoseconds
          );
        });
        if (raced) continue;
        entry.session.adoptOpened(candidate);
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

    const opened = await this.reconcile(entry, options);
    return opened.ok ? this.logicalView(entry, opened, logicalRoot) : opened;
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

    const reconciled = await this.reconcile(entry, options);
    if (reconciled.ok) return this.logicalView(entry, reconciled, logicalRoot);
    if (entry.session.coherenceState() !== 'invalid') return reconciled;
    const coherent = entry.session.openedGeneration();
    return coherent ? this.logicalView(entry, coherent, logicalRoot) : reconciled;
  }

  private async proveCommittedGeneration(
    entry: ResidentEntry,
    opened: SuccessfulOpen,
    observed: ProjectSourceInventory,
    changedCanonicalPaths: readonly string[],
  ): Promise<ProjectSourceInventory | null> {
    for (const relativePath of changedCanonicalPaths) {
      const expected = opened.snapshot.fileRevisions[relativePath];
      const absolute = this.residentFileSystem.joinPath(entry.canonicalRoot, relativePath);
      if (!expected) {
        if ((await this.residentFileSystem.inspect(absolute)) !== 'missing') return null;
        continue;
      }
      try {
        const actual = await this.residentFileSystem.readFileRevision(absolute);
        if (actual.byteSize !== expected.byteSize || actual.contentHash !== expected.contentHash)
          return null;
      } catch {
        return null;
      }
    }
    const proof = await this.captureInventory(opened.snapshot);
    return proof && projectSourceInventoriesEqual(observed, proof) ? proof : null;
  }

  private async adoptCommittedTransaction(
    entry: ResidentEntry,
    before: SuccessfulOpen,
    prewriteAuthority: ProjectSourceInventory,
    written: ProjectWorkspaceWriteResult,
    options: ProjectWorkspaceWriteOptions,
  ): Promise<void> {
    const observed = await this.captureInventory(written.snapshot);
    if (!observed) {
      entry.session.markResyncNeeded();
      this.sessions.delete(entry.canonicalRoot);
      return;
    }
    const changes = changedInventoryPaths(prewriteAuthority, observed);
    const canonicalPaths = new Set([
      ...before.snapshot.canonicalSourceFiles,
      ...written.snapshot.canonicalSourceFiles,
    ]);
    const changedCanonicalPaths = [...canonicalPaths]
      .filter(
        (path) =>
          (before.snapshot.fileRevisions[path]?.contentHash ?? 'absent') !==
          (written.snapshot.fileRevisions[path]?.contentHash ?? 'absent'),
      )
      .sort();
    const transactionPaths = new Set([
      ...changedCanonicalPaths,
      ...(options.extraTargets ?? []).map((target) => target.path),
    ]);
    if (changes.paths.some((path) => !transactionPaths.has(path))) {
      entry.session.markResyncNeeded();
      this.sessions.delete(entry.canonicalRoot);
      return;
    }
    if (
      JSON.stringify(before.snapshot.scriptSourcePaths) !==
      JSON.stringify(written.snapshot.scriptSourcePaths)
    ) {
      entry.session.markResyncNeeded();
      this.sessions.delete(entry.canonicalRoot);
      await this.openCold(entry.canonicalRoot, {});
      return;
    }
    const candidate = entry.session
      .service()
      .advanceCommittedSnapshot(before, written.snapshot, changedCanonicalPaths);

    if (!candidate?.ok) {
      entry.session.markResyncNeeded();
      this.sessions.delete(entry.canonicalRoot);
      return;
    }
    const proof = await this.proveCommittedGeneration(
      entry,
      candidate,
      observed,
      changedCanonicalPaths,
    );
    if (!proof || candidate.snapshot.workspaceRevision !== written.snapshot.workspaceRevision) {
      entry.session.markResyncNeeded();
      this.sessions.delete(entry.canonicalRoot);
      return;
    }
    entry.session.adoptOpened(candidate, {
      preserveInvalidOverlay: entry.session.invalidAuthoringSources().length > 0,
    });
    entry.authority = mergeInventoryPaths(entry.authority, proof, [
      ...new Set([...changes.paths, ...changedCanonicalPaths]),
    ]);
    this.bindSnapshot(entry, candidate.snapshot);
    await entry.session.captureAuthoringFileStamps(changes.paths);
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

    return entry.session.runExclusive(async () => {
      const before = entry.session.openedGeneration();
      if (!before) {
        entry.session.markResyncNeeded();
        this.sessions.delete(entry.canonicalRoot);
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

      const prewriteAuthority = await this.captureInventory(before.snapshot);
      if (!prewriteAuthority) {
        entry.session.markResyncNeeded();
        this.sessions.delete(entry.canonicalRoot);
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
      const written = await entry.session
        .service()
        .write(entry.canonicalRoot, expectedRevision, project, editorState, sourcePathOverrides, {
          ...options,
          preflightSnapshot: before.snapshot,
          refreshAfterCommit: false,
        });
      await entry.session.service().writeEditorLocalState(entry.canonicalRoot, editorState);
      await this.adoptCommittedTransaction(entry, before, prewriteAuthority, written, options);
      return written;
    });
  }

  async reconcileAfterOpaqueWrite(projectRoot: string): Promise<void> {
    const canonicalRoot = await this.canonicalProjectRoot(
      this.residentFileSystem.resolvePath(projectRoot),
    );
    const entry = canonicalRoot ? this.sessions.get(canonicalRoot) : undefined;
    if (!entry) return;

    entry.session.markResyncNeeded();
    this.sessions.delete(entry.canonicalRoot);
    // Opaque effects may include local editor state or Project source ownership changes that are
    // intentionally outside the resident inventory. Re-admit from disk instead of guessing which
    // parts of the prior generation remain valid.
    await this.openCold(entry.canonicalRoot, {});
  }

  async hasResidentSession(projectRoot: string): Promise<boolean> {
    const canonicalRoot = await this.canonicalProjectRoot(
      this.residentFileSystem.resolvePath(projectRoot),
    );
    return canonicalRoot !== null && this.sessions.has(canonicalRoot);
  }

  evictIdleSessions(maxIdleMilliseconds: number, nowMilliseconds = Date.now()): number {
    if (!Number.isFinite(maxIdleMilliseconds) || maxIdleMilliseconds <= 0) return 0;
    let evicted = 0;
    for (const [canonicalRoot, entry] of this.sessions) {
      if (nowMilliseconds - entry.lastUsedAtMilliseconds < maxIdleMilliseconds) continue;
      entry.session.markResyncNeeded();
      this.sessions.delete(canonicalRoot);
      evicted += 1;
    }
    return evicted;
  }

  async verifyReadAuthority(snapshot: LoadedProjectWorkspaceSnapshot): Promise<boolean> {
    const binding = this.snapshotBindings.get(snapshot);
    if (!binding) return true;
    const current = await this.captureInventory(binding.canonicalSnapshot);
    return current !== null && projectSourceInventoriesEqual(binding.entry.authority, current);
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
