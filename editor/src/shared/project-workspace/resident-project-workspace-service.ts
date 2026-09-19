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
} from './project-workspace-service';
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
      if (
        revision.byteSize !== admitted.byteSize ||
        revision.contentHash !== admitted.contentHash
      )
        return null;
    }
    return inventory;
  } catch {
    return null;
  }
}

type SuccessfulOpen = Extract<ProjectWorkspaceOpenResult, { ok: true }>;

type ResidentEntry = {
  readonly canonicalRoot: string;
  readonly session: ResidentProjectWorkspaceSession;
  authority: ProjectSourceInventory;
};

type SnapshotBinding = Readonly<{
  entry: ResidentEntry;
  canonicalSnapshot: LoadedProjectWorkspaceSnapshot;
}>;

function inventoryByPath(inventory: ProjectSourceInventory): Map<string, ProjectSourceInventory['entries'][number]> {
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
    if (
      before.byteSize !== after.byteSize ||
      before.mtimeNanoseconds !== after.mtimeNanoseconds
    )
      changed.push(path);
  }
  return { structural, paths: Object.freeze(changed.sort()) };
}

/**
 * Read-oriented ProjectWorkspaceService adapter backed by the shared resident session core.
 * A physical Project root has one coherent in-memory generation. Request-time metadata inventories
 * establish disk authority; exact file reads remain limited to changed semantic sources.
 */
export class ResidentProjectWorkspaceService extends ProjectWorkspaceService {
  private readonly sessions = new Map<string, ResidentEntry>();
  private readonly snapshotBindings = new WeakMap<ProjectWorkspaceSnapshot, SnapshotBinding>();

  constructor(
    private readonly residentFileSystem: ProjectWorkspaceFileSystem,
    private readonly createSessionWorkspace: ResidentProjectWorkspaceServiceFactory = (fileSystem) =>
      new ProjectWorkspaceService(fileSystem),
  ) {
    super(residentFileSystem);
  }

  private captureInventory(
    snapshot: LoadedProjectWorkspaceSnapshot,
  ): Promise<ProjectSourceInventory | null> {
    return captureResidentInventory(this.residentFileSystem, snapshot);
  }

  private bindSnapshot(entry: ResidentEntry, snapshot: LoadedProjectWorkspaceSnapshot): void {
    this.snapshotBindings.set(snapshot, { entry, canonicalSnapshot: snapshot });
  }

  private logicalView(entry: ResidentEntry, opened: SuccessfulOpen, logicalRoot: string): SuccessfulOpen {
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
      return this.residentFileSystem.resolvePath(await this.residentFileSystem.realpath(projectRoot));
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
      const entry: ResidentEntry = { canonicalRoot, session, authority };
      this.sessions.set(canonicalRoot, entry);
      this.bindSnapshot(entry, opened.snapshot);
      return opened;
    }
    return workspace.open(canonicalRoot, options);
  }

  private async reconcile(
    entry: ResidentEntry,
    options: ProjectWorkspaceOpenOptions,
  ): Promise<ProjectWorkspaceOpenResult> {
    return entry.session.runExclusive(async () => {
      const current = entry.session.openedGeneration();
      if (!current) {
        const reopened = await entry.session.service().open(entry.canonicalRoot, options);
        if (reopened.ok) entry.session.adoptOpened(reopened);
        return reopened;
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const observed = await this.captureInventory(current.snapshot);
        if (!observed) {
          entry.session.markResyncNeeded();
          return entry.session.service().open(entry.canonicalRoot, options);
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
          candidate = await entry.session.service().reconcileExistingSources(current, changedSources);
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
      return entry.session.service().open(entry.canonicalRoot, options);
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

  async hasResidentSession(projectRoot: string): Promise<boolean> {
    const canonicalRoot = await this.canonicalProjectRoot(
      this.residentFileSystem.resolvePath(projectRoot),
    );
    return canonicalRoot !== null && this.sessions.has(canonicalRoot);
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
