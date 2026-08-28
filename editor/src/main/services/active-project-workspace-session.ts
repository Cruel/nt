import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EditorProjectState } from '../../shared/project-schema/editor-project-state';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  authoringDependencyReverseImpactClosure,
  buildAuthoringStructuralDependencyGraph,
  findAuthoringDependencyOwnersByPath,
} from '../../shared/authoring-dependency-graph';
import { jsonPointerSegmentsOverlap } from '../../shared/json-pointer';
import {
  assetSourcePaths,
  projectWorkspaceFiles,
  type LoadedProjectWorkspaceSnapshot,
  type ProjectWorkspaceFileRevision,
  type ProjectWorkspaceOpenResult,
  type ProjectWorkspaceService,
} from '../../shared/project-workspace/project-workspace-service';
import { NodeProjectWorkspaceFileSystem } from '../../shared/project-workspace/node-project-workspace-file-system';
import type { ProjectWorkspaceFileSystem } from '../../shared/project-workspace/project-workspace-file-system';
import { createHostProjectWorkspaceService } from '../../shared/project-workspace/node-project-workspace-service';

class ActiveProjectWorkspaceFileSystem implements ProjectWorkspaceFileSystem {
  private readonly raw = new NodeProjectWorkspaceFileSystem();
  private readonly textByPath = new Map<string, string>();
  private readonly revisionByPath = new Map<string, ProjectWorkspaceFileRevision>();
  private readonly inspectByPath = new Map<string, 'missing' | 'file' | 'directory'>();
  private readonly directoryEntriesByPath = new Map<string, readonly string[]>();
  private readonly realpathByPath = new Map<string, string>();

  seed(snapshot: LoadedProjectWorkspaceSnapshot): void {
    const projected = projectWorkspaceFiles(
      snapshot.project,
      snapshot.project.editor,
      snapshot.scriptSourcePaths,
    );
    const childrenByDirectory = new Map<string, Set<string>>();
    const registerDirectory = (absolute: string) => {
      const key = this.key(absolute);
      this.inspectByPath.set(key, 'directory');
      if (!childrenByDirectory.has(key)) childrenByDirectory.set(key, new Set());
    };
    registerDirectory(snapshot.projectRoot);
    for (const [relative, text] of Object.entries(projected)) {
      const absolute = this.key(this.joinPath(snapshot.projectRoot, relative));
      this.textByPath.set(absolute, text);
      this.inspectByPath.set(absolute, 'file');
      let child = absolute;
      let directory = this.key(this.dirname(child));
      while (
        directory === this.key(snapshot.projectRoot) ||
        directory.startsWith(`${this.key(snapshot.projectRoot)}${path.sep}`)
      ) {
        registerDirectory(directory);
        childrenByDirectory.get(directory)!.add(path.basename(child));
        if (directory === this.key(snapshot.projectRoot)) break;
        child = directory;
        directory = this.key(this.dirname(directory));
      }
    }
    for (const [directory, children] of childrenByDirectory)
      this.directoryEntriesByPath.set(directory, [...children].sort());
    for (const [relative, revision] of Object.entries(snapshot.fileRevisions))
      this.revisionByPath.set(this.key(this.joinPath(snapshot.projectRoot, relative)), revision);
  }

  invalidate(projectRoot: string, relativePath: string): void {
    const root = this.key(projectRoot);
    const absolute = this.key(this.joinPath(projectRoot, relativePath));
    const prefix = absolute.endsWith(path.sep) ? absolute : `${absolute}${path.sep}`;
    const invalidateDescendants = <T>(cache: Map<string, T>) => {
      for (const key of cache.keys())
        if (key === absolute || key.startsWith(prefix)) cache.delete(key);
    };
    invalidateDescendants(this.textByPath);
    invalidateDescendants(this.revisionByPath);
    invalidateDescendants(this.inspectByPath);
    invalidateDescendants(this.directoryEntriesByPath);
    invalidateDescendants(this.realpathByPath);
    let ancestor = this.key(this.dirname(absolute));
    while (ancestor === root || ancestor.startsWith(`${root}${path.sep}`)) {
      this.directoryEntriesByPath.delete(ancestor);
      if (ancestor === root) break;
      ancestor = this.key(this.dirname(ancestor));
    }
  }

  invalidateInventory(): void {
    this.directoryEntriesByPath.clear();
    this.inspectByPath.clear();
  }

  private key(value: string): string {
    return this.resolvePath(value);
  }

  resolvePath(value: string): string {
    return this.raw.resolvePath(value);
  }
  joinPath(...values: string[]): string {
    return this.raw.joinPath(...values);
  }
  dirname(value: string): string {
    return this.raw.dirname(value);
  }
  relativePath(from: string, to: string): string {
    return this.raw.relativePath(from, to);
  }
  async inspect(value: string): Promise<'missing' | 'file' | 'directory'> {
    const key = this.key(value);
    const cached = this.inspectByPath.get(key);
    if (cached) return cached;
    const inspected = await this.raw.inspect(value);
    this.inspectByPath.set(key, inspected);
    return inspected;
  }
  inspectFresh(value: string): Promise<'missing' | 'file' | 'directory'> {
    return this.raw.inspect(value);
  }
  async listDirectory(value: string): Promise<readonly string[]> {
    const key = this.key(value);
    const cached = this.directoryEntriesByPath.get(key);
    if (cached) return cached;
    const entries = await this.raw.listDirectory(value);
    const normalized = [...entries].sort();
    this.directoryEntriesByPath.set(key, normalized);
    return normalized;
  }
  async readText(value: string): Promise<string> {
    const key = this.key(value);
    const cached = this.textByPath.get(key);
    if (cached !== undefined) return cached;
    const text = await this.raw.readText(value);
    this.textByPath.set(key, text);
    return text;
  }
  readBytes(value: string): Promise<Uint8Array> {
    return this.raw.readBytes(value);
  }
  /** Always fresh: transaction CAS and other exact-byte callers use this method. */
  readFileRevision(
    value: string,
  ): Promise<Readonly<{ contentHash: `sha256:${string}`; byteSize: number }>> {
    return this.raw.readFileRevision(value);
  }
  async readCachedFileRevision(
    value: string,
  ): Promise<Readonly<{ contentHash: `sha256:${string}`; byteSize: number }> | null> {
    const key = this.key(value);
    const cached = this.revisionByPath.get(key);
    if (cached) return cached;
    try {
      const revision = await this.raw.readFileRevision(value);
      this.revisionByPath.set(key, revision);
      return revision;
    } catch {
      return null;
    }
  }
  async writeTextAtomic(value: string, text: string): Promise<void> {
    await this.raw.writeTextAtomic(value, text);
    this.invalidate(this.dirname(value), path.basename(value));
  }
  async writeBytesAtomic(value: string, bytes: Uint8Array): Promise<void> {
    await this.raw.writeBytesAtomic(value, bytes);
    this.invalidate(this.dirname(value), path.basename(value));
  }
  async movePathAtomic(from: string, to: string): Promise<void> {
    await this.raw.movePathAtomic(from, to);
    this.invalidate(this.dirname(from), path.basename(from));
    this.invalidate(this.dirname(to), path.basename(to));
  }
  async removeFile(value: string): Promise<void> {
    await this.raw.removeFile(value);
    this.invalidate(this.dirname(value), path.basename(value));
  }
  async createDirectory(value: string): Promise<void> {
    await this.raw.createDirectory(value);
    this.invalidate(this.dirname(value), path.basename(value));
  }
  async createDirectoryExclusive(value: string): Promise<boolean> {
    const created = await this.raw.createDirectoryExclusive(value);
    if (created) this.invalidate(this.dirname(value), path.basename(value));
    return created;
  }
  async removeDirectory(value: string): Promise<void> {
    await this.raw.removeDirectory(value);
    this.invalidate(this.dirname(value), path.basename(value));
  }
  async realpath(value: string): Promise<string> {
    const key = this.key(value);
    const cached = this.realpathByPath.get(key);
    if (cached) return cached;
    const resolved = await this.raw.realpath(value);
    this.realpathByPath.set(key, resolved);
    return resolved;
  }
}

export type RecoveryFileOwnershipHints = Readonly<Record<string, readonly string[]>>;
export type ActiveProjectWorkspaceCoherence = 'coherent' | 'resync-needed' | 'invalid';

export interface InvalidAuthoringSourceBlock {
  readonly files: readonly string[];
  readonly ownerPaths: readonly string[];
}

interface AuthoringFileStamp {
  readonly size: number;
  readonly mtimeMs: number;
}

export class ActiveProjectWorkspaceSession {
  private readonly fileSystem = new ActiveProjectWorkspaceFileSystem();
  private readonly workspace: ProjectWorkspaceService = createHostProjectWorkspaceService(
    this.fileSystem,
  );
  private snapshotValue: LoadedProjectWorkspaceSnapshot;
  private editorStateValue: EditorProjectState;
  private mutationTail: Promise<void> = Promise.resolve();
  private coherenceValue: ActiveProjectWorkspaceCoherence = 'coherent';
  private readonly authoringFileStamps = new Map<string, AuthoringFileStamp | null>();
  private readonly invalidAuthoringSourcePaths = new Set<string>();

  private constructor(snapshot: LoadedProjectWorkspaceSnapshot, editorState: EditorProjectState) {
    this.snapshotValue = snapshot;
    this.editorStateValue = editorState;
    this.fileSystem.seed(snapshot);
  }

  static fromOpened(
    opened: Extract<ProjectWorkspaceOpenResult, { ok: true }>,
  ): ActiveProjectWorkspaceSession {
    return new ActiveProjectWorkspaceSession(opened.snapshot, opened.editorState);
  }

  static fromSnapshot(
    snapshot: LoadedProjectWorkspaceSnapshot,
    editorState: EditorProjectState,
  ): ActiveProjectWorkspaceSession {
    return new ActiveProjectWorkspaceSession(snapshot, editorState);
  }

  projectRoot(): string {
    return this.snapshotValue.projectRoot;
  }

  manifestPath(): string {
    return this.snapshotValue.manifestPath;
  }

  snapshot(): LoadedProjectWorkspaceSnapshot {
    return this.snapshotValue;
  }

  editorState(): EditorProjectState {
    return this.editorStateValue;
  }

  project(): AuthoringProject {
    return this.snapshotValue.project;
  }

  service(): ProjectWorkspaceService {
    return this.workspace;
  }

  coherenceState(): ActiveProjectWorkspaceCoherence {
    return this.coherenceValue;
  }

  markResyncNeeded(): void {
    this.coherenceValue = 'resync-needed';
  }

  invalidAuthoringSources(): readonly string[] {
    return [...this.invalidAuthoringSourcePaths].sort();
  }

  knownAssetSourcePaths(): string[] {
    return assetSourcePaths(this.snapshotValue.project);
  }

  knownFileRevision(relativePath: string): `sha256:${string}` | undefined {
    return this.snapshotValue.fileRevisions[relativePath]?.contentHash;
  }

  async readFreshRevision(relativePath: string): Promise<`sha256:${string}` | 'absent'> {
    const absolute = this.fileSystem.joinPath(this.snapshotValue.projectRoot, relativePath);
    if ((await this.fileSystem.inspectFresh(absolute)) !== 'file') return 'absent';
    try {
      return (await this.fileSystem.readFileRevision(absolute)).contentHash;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
      throw error;
    }
  }

  requiresAuthoringReassembly(
    relativePath: string,
    observedRevision: `sha256:${string}` | 'absent',
  ): boolean {
    if (
      this.invalidAuthoringSourcePaths.has('*') ||
      this.invalidAuthoringSourcePaths.has(relativePath)
    )
      return true;
    return observedRevision !== (this.knownFileRevision(relativePath) ?? 'absent');
  }

  async observeAssetRevisions(
    relativePaths: readonly string[],
  ): Promise<Record<string, `sha256:${string}` | 'absent'>> {
    const revisions: Record<string, `sha256:${string}` | 'absent'> = {};
    for (const relativePath of [...new Set(relativePaths)].sort()) {
      const absolute = this.fileSystem.joinPath(this.snapshotValue.projectRoot, relativePath);
      const kind = await this.fileSystem.inspectFresh(absolute);
      if (kind === 'directory') continue;
      let revision: `sha256:${string}` | 'absent';
      if (kind === 'missing') revision = 'absent';
      else {
        try {
          revision = (await this.fileSystem.readFileRevision(absolute)).contentHash;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          revision = 'absent';
        }
      }
      revisions[relativePath] = revision;
    }
    return revisions;
  }

  invalidate(relativePaths: readonly string[]): void {
    for (const relativePath of relativePaths)
      this.fileSystem.invalidate(this.snapshotValue.projectRoot, relativePath);
  }

  adopt(snapshot: LoadedProjectWorkspaceSnapshot, editorState: EditorProjectState): void {
    if (snapshot.projectRoot !== this.snapshotValue.projectRoot)
      throw new Error('Active workspace snapshot belongs to a different project root.');
    this.snapshotValue = snapshot;
    this.editorStateValue = editorState;
    this.fileSystem.seed(snapshot);
  }

  private async fileStamp(relativePath: string): Promise<AuthoringFileStamp | null> {
    try {
      const stat = await fs.stat(path.join(this.snapshotValue.projectRoot, relativePath));
      return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null;
    } catch {
      return null;
    }
  }

  async captureAuthoringFileStamps(
    paths: readonly string[] = this.snapshotValue.canonicalSourceFiles,
  ) {
    for (const relativePath of paths)
      this.authoringFileStamps.set(relativePath, await this.fileStamp(relativePath));
  }

  async resynchronizeAuthoring(): Promise<{
    opened: ProjectWorkspaceOpenResult;
    changedPaths: readonly string[];
  }> {
    const before = this.snapshotValue;
    const suspicious = new Set<string>();
    for (const relativePath of before.canonicalSourceFiles) {
      const previous = this.authoringFileStamps.get(relativePath);
      const current = await this.fileStamp(relativePath);
      if (
        previous === undefined ||
        previous?.size !== current?.size ||
        previous?.mtimeMs !== current?.mtimeMs
      )
        suspicious.add(relativePath);
    }
    this.invalidate([...suspicious]);
    // The watcher may have missed additions/deletions while suspended or after an error. Keep
    // cached contents/revisions for known files, but force directory membership to be rediscovered.
    this.fileSystem.invalidateInventory();
    const opened = await this.workspace.open(before.projectRoot);
    if (!opened.ok) {
      this.coherenceValue = 'invalid';
      if (suspicious.size === 0) this.invalidAuthoringSourcePaths.add('*');
      else suspicious.forEach((relativePath) => this.invalidAuthoringSourcePaths.add(relativePath));
      return { opened, changedPaths: [...suspicious].sort() };
    }
    const allPaths = new Set([
      ...before.canonicalSourceFiles,
      ...opened.snapshot.canonicalSourceFiles,
    ]);
    for (const relativePath of allPaths) {
      if (
        (before.fileRevisions[relativePath]?.contentHash ?? 'absent') !==
        (opened.snapshot.fileRevisions[relativePath]?.contentHash ?? 'absent')
      )
        suspicious.add(relativePath);
    }
    this.adopt(opened.snapshot, opened.editorState);
    this.invalidAuthoringSourcePaths.clear();
    this.authoringFileStamps.clear();
    await this.captureAuthoringFileStamps();
    this.coherenceValue = 'coherent';
    return { opened, changedPaths: [...suspicious].sort() };
  }

  editorStateWithRecoveryBaselines(
    editorState: EditorProjectState,
    ownershipHints: RecoveryFileOwnershipHints = {},
  ): EditorProjectState {
    const saveUnitsById: EditorProjectState['recovery']['saveUnitsById'] = {};
    for (const [saveUnitId, entry] of Object.entries(editorState.recovery.saveUnitsById)) {
      const existing = entry.baselineFileRevisions ?? {};
      const files = new Set([
        ...Object.keys(existing),
        ...(this.snapshotValue.saveUnitFileOwnership[saveUnitId]?.files ?? []),
        ...(ownershipHints[saveUnitId] ?? []),
      ]);
      const baselineFileRevisions: Record<string, `sha256:${string}` | 'absent'> = {};
      for (const file of [...files].sort()) {
        const persisted = existing[file];
        baselineFileRevisions[file] =
          persisted === 'absent'
            ? 'absent'
            : persisted
              ? (persisted as `sha256:${string}`)
              : (this.snapshotValue.fileRevisions[file]?.contentHash ?? 'absent');
      }
      saveUnitsById[saveUnitId] = { ...entry, baselineFileRevisions };
    }
    return {
      ...editorState,
      recovery: { ...editorState.recovery, saveUnitsById },
    };
  }

  advanceRecoveryBaselines(
    editorState: EditorProjectState,
    before: LoadedProjectWorkspaceSnapshot,
    after: LoadedProjectWorkspaceSnapshot,
  ): EditorProjectState {
    const changedFiles = new Set(
      [...new Set([...before.canonicalSourceFiles, ...after.canonicalSourceFiles])].filter(
        (file) =>
          (before.fileRevisions[file]?.contentHash ?? 'absent') !==
          (after.fileRevisions[file]?.contentHash ?? 'absent'),
      ),
    );
    if (changedFiles.size === 0) return editorState;
    const saveUnitsById: EditorProjectState['recovery']['saveUnitsById'] = {};
    for (const [saveUnitId, entry] of Object.entries(editorState.recovery.saveUnitsById)) {
      if (!entry.baselineFileRevisions) {
        saveUnitsById[saveUnitId] = entry;
        continue;
      }
      const baselineFileRevisions = { ...entry.baselineFileRevisions };
      for (const file of changedFiles)
        if (file in baselineFileRevisions)
          baselineFileRevisions[file] = after.fileRevisions[file]?.contentHash ?? 'absent';
      saveUnitsById[saveUnitId] = { ...entry, baselineFileRevisions };
    }
    return {
      ...editorState,
      recovery: { ...editorState.recovery, saveUnitsById },
    };
  }

  async persistEditorState(
    editorState: EditorProjectState,
    ownershipHints: RecoveryFileOwnershipHints = {},
  ): Promise<EditorProjectState> {
    return this.runExclusive(async () => {
      const persisted = this.editorStateWithRecoveryBaselines(editorState, ownershipHints);
      await this.workspace.writeEditorLocalState(this.snapshotValue.projectRoot, persisted);
      this.editorStateValue = persisted;
      return persisted;
    });
  }

  async reassemble(changedPaths: readonly string[]): Promise<ProjectWorkspaceOpenResult> {
    this.invalidate(changedPaths);
    const opened = await this.workspace.open(this.snapshotValue.projectRoot);
    if (opened.ok) {
      this.adopt(opened.snapshot, opened.editorState);
      this.invalidAuthoringSourcePaths.clear();
      await this.captureAuthoringFileStamps(changedPaths);
      this.coherenceValue = 'coherent';
    } else {
      changedPaths.forEach((relativePath) => this.invalidAuthoringSourcePaths.add(relativePath));
      this.coherenceValue = 'invalid';
    }
    return opened;
  }

  async recoverPendingTransactions(): Promise<{
    recovered: boolean;
    opened?: ProjectWorkspaceOpenResult;
    changedPaths: readonly string[];
  }> {
    const transactionsRoot = path.join(this.snapshotValue.projectRoot, '.noveltea', 'transactions');
    let entries: string[];
    try {
      entries = await fs.readdir(transactionsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { recovered: false, changedPaths: [] };
      throw error;
    }
    const journals = entries.filter(
      (entry) =>
        entry !== '.writer-lock' &&
        entry !== '.writer-lock-reclaim' &&
        !entry.startsWith('.writer-lock.claimed-'),
    );
    if (journals.length === 0) return { recovered: false, changedPaths: [] };

    const before = this.snapshotValue;
    this.fileSystem.invalidate(this.snapshotValue.projectRoot, '.noveltea/transactions');
    const opened = await this.workspace.open(this.snapshotValue.projectRoot);
    if (!opened.ok) {
      this.coherenceValue = 'invalid';
      this.invalidAuthoringSourcePaths.add('*');
      return { recovered: true, opened, changedPaths: [] };
    }
    const changedPaths = [
      ...new Set([...before.canonicalSourceFiles, ...opened.snapshot.canonicalSourceFiles]),
    ]
      .filter(
        (relativePath) =>
          (before.fileRevisions[relativePath]?.contentHash ?? 'absent') !==
          (opened.snapshot.fileRevisions[relativePath]?.contentHash ?? 'absent'),
      )
      .sort();
    this.adopt(opened.snapshot, opened.editorState);
    this.invalidAuthoringSourcePaths.clear();
    await this.captureAuthoringFileStamps(changedPaths);
    this.coherenceValue = 'coherent';
    return { recovered: true, opened, changedPaths };
  }

  invalidSourceBlockForMutation(
    saveUnitIds: readonly string[],
    affectedPaths: readonly string[],
  ): InvalidAuthoringSourceBlock | null {
    if (this.invalidAuthoringSourcePaths.size === 0) return null;
    const invalidFiles = [...this.invalidAuthoringSourcePaths].sort();
    if (invalidFiles.includes('*') || invalidFiles.includes('project.json'))
      return { files: invalidFiles, ownerPaths: ['/'] };

    const selectedFiles = new Set<string>();
    for (const saveUnitId of saveUnitIds)
      for (const file of this.snapshotValue.saveUnitFileOwnership[saveUnitId]?.files ?? [])
        selectedFiles.add(file);
    const directlySelected = invalidFiles.filter((file) => selectedFiles.has(file));
    if (directlySelected.length > 0)
      return { files: directlySelected, ownerPaths: [...affectedPaths].sort() };

    const invalidOwnerPaths = new Set<string>();
    for (const file of invalidFiles) {
      const layout = file.match(/^records\/layouts\/([^/]+)\/layout\.(?:json|rml|rcss|lua)$/);
      const record = file.match(/^records\/([^/]+)\/([^/]+)\.json$/);
      const scriptOwner = Object.entries(this.snapshotValue.scriptSourcePaths).find(
        ([, sourcePath]) => sourcePath === file,
      );
      if (layout) invalidOwnerPaths.add(`/layouts/${layout[1]}`);
      else if (record) invalidOwnerPaths.add(`/${record[1]}/${record[2]}`);
      else if (scriptOwner) invalidOwnerPaths.add(`/scripts/${scriptOwner[0]}`);
      else if (file === 'traits.json') invalidOwnerPaths.add('/traits');
      else if (file === 'localization.json') invalidOwnerPaths.add('/localization');
      else if (file === 'editor.json') invalidOwnerPaths.add('/editor');
      else {
        const attributedPaths = Object.values(this.snapshotValue.saveUnitFileOwnership)
          .filter((ownership) => ownership.files.includes(file))
          .flatMap((ownership) => ownership.paths);
        if (attributedPaths.length === 0) return { files: invalidFiles, ownerPaths: ['/'] };
        const specificPaths = attributedPaths.filter(
          (candidate) =>
            !attributedPaths.some(
              (other) =>
                other !== candidate &&
                other.startsWith(`${candidate}/`) &&
                jsonPointerSegmentsOverlap(candidate, other),
            ),
        );
        specificPaths.forEach((ownerPath) => invalidOwnerPaths.add(ownerPath));
      }
    }

    const ownerPaths = [...invalidOwnerPaths].sort();
    if (
      affectedPaths.some((affectedPath) =>
        ownerPaths.some((ownerPath) => jsonPointerSegmentsOverlap(affectedPath, ownerPath)),
      )
    )
      return { files: invalidFiles, ownerPaths };

    const graph = buildAuthoringStructuralDependencyGraph(this.snapshotValue.project);
    const rootNodes = ownerPaths.flatMap((ownerPath) =>
      findAuthoringDependencyOwnersByPath(graph, ownerPath),
    );
    const impactedOwnerPaths = [
      ...new Set(
        authoringDependencyReverseImpactClosure(
          graph,
          rootNodes.map((node) => node.key),
        ).map((node) => node.owningPath),
      ),
    ].sort();
    if (
      affectedPaths.some((affectedPath) =>
        impactedOwnerPaths.some((ownerPath) => jsonPointerSegmentsOverlap(affectedPath, ownerPath)),
      )
    )
      return { files: invalidFiles, ownerPaths: impactedOwnerPaths };
    return null;
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
