import { captureAuthoringValidationAuthorityInputs } from '../authoring-cache';
import {
  authoringDependencyReverseImpactClosure,
  buildAuthoringStructuralDependencyGraph,
  findAuthoringDependencyOwnersByPath,
} from '../authoring-dependency-graph';
import { jsonPointerSegmentsOverlap } from '../json-pointer';
import type { ProjectSourceInventory } from '../project-source-inventory';
import type { AuthoringProject } from '../project-schema/authoring-project';
import type { EditorProjectState } from '../project-schema/editor-project-state';
import type {
  ProjectWorkspaceFileSystem,
  ProjectWorkspacePathMetadata,
} from './project-workspace-file-system';
import {
  assetSourcePaths,
  projectWorkspaceFile,
  projectWorkspaceFiles,
  ProjectWorkspaceService,
  type LoadedProjectWorkspaceSnapshot,
  type ProjectWorkspaceFileRevision,
  type ProjectWorkspaceOpenResult,
} from './project-workspace-service';

export interface ResidentProjectWorkspaceSessionHost {
  readonly fileSystem: ProjectWorkspaceFileSystem;
  readonly createWorkspaceService?: (
    fileSystem: ProjectWorkspaceFileSystem,
  ) => ProjectWorkspaceService;
}

class ResidentProjectWorkspaceFileSystem implements ProjectWorkspaceFileSystem {
  readonly readPathMetadata?: (value: string) => Promise<ProjectWorkspacePathMetadata>;
  private readonly textByPath = new Map<string, string>();
  private readonly revisionByPath = new Map<string, ProjectWorkspaceFileRevision>();
  private readonly inspectByPath = new Map<string, 'missing' | 'file' | 'directory'>();
  private readonly directoryEntriesByPath = new Map<string, readonly string[]>();
  private readonly realpathByPath = new Map<string, string>();

  constructor(private readonly raw: ProjectWorkspaceFileSystem) {
    this.readPathMetadata = raw.readPathMetadata?.bind(raw);
  }

  seed(snapshot: LoadedProjectWorkspaceSnapshot): void {
    const projected = projectWorkspaceFiles(
      snapshot.project,
      snapshot.project.editor,
      snapshot.scriptSourcePaths,
    );
    this.seedEntries(snapshot, Object.entries(projected));
  }

  seedOpened(opened: Extract<ProjectWorkspaceOpenResult, { ok: true }>): void {
    this.seedEntries(
      opened.snapshot,
      Object.entries(opened.sourceContributions).map(([relativePath, contribution]) => [
        relativePath,
        contribution.kind === 'json'
          ? `${JSON.stringify(contribution.parsed, null, 2)}\n`
          : contribution.text,
      ]),
    );
  }

  private seedEntries(
    snapshot: LoadedProjectWorkspaceSnapshot,
    entries: readonly (readonly [string, string])[],
  ): void {
    this.textByPath.clear();
    this.revisionByPath.clear();
    this.inspectByPath.clear();
    this.directoryEntriesByPath.clear();
    this.realpathByPath.clear();
    const root = this.key(snapshot.projectRoot);
    const childrenByDirectory = new Map<string, Set<string>>();
    const registerDirectory = (absolute: string) => {
      const key = this.key(absolute);
      this.inspectByPath.set(key, 'directory');
      if (!childrenByDirectory.has(key)) childrenByDirectory.set(key, new Set());
    };
    registerDirectory(root);
    for (const [relative, text] of entries) {
      const absolute = this.key(this.joinPath(root, relative));
      this.textByPath.set(absolute, text);
      this.inspectByPath.set(absolute, 'file');
      let child = absolute;
      let directory = this.key(this.dirname(child));
      while (this.isSameOrDescendant(root, directory)) {
        registerDirectory(directory);
        const childName = this.relativePath(directory, child)
          .replaceAll('\\', '/')
          .split('/')
          .filter(Boolean)
          .at(-1);
        if (childName) childrenByDirectory.get(directory)!.add(childName);
        if (directory === root) break;
        child = directory;
        directory = this.key(this.dirname(directory));
      }
    }
    for (const [directory, children] of childrenByDirectory)
      this.directoryEntriesByPath.set(directory, [...children].sort());
    for (const [relative, revision] of Object.entries(snapshot.fileRevisions))
      this.revisionByPath.set(this.key(this.joinPath(root, relative)), revision);
  }

  adoptProjection(
    snapshot: LoadedProjectWorkspaceSnapshot,
    relativePaths: readonly string[],
  ): void {
    const root = this.key(snapshot.projectRoot);
    for (const relativePath of new Set(relativePaths)) {
      const absolute = this.key(this.joinPath(root, relativePath));
      const text = projectWorkspaceFile(
        snapshot.project,
        snapshot.project.editor,
        snapshot.scriptSourcePaths,
        relativePath,
      );
      const revision = snapshot.fileRevisions[relativePath];
      if (text === undefined || !revision) {
        this.invalidateAbsolute(absolute);
        continue;
      }
      this.textByPath.set(absolute, text);
      this.revisionByPath.set(absolute, revision);
      this.inspectByPath.set(absolute, 'file');
    }
  }

  invalidate(projectRoot: string, relativePath: string): void {
    this.invalidateAbsolute(this.joinPath(projectRoot, relativePath));
  }

  invalidateInventory(): void {
    this.directoryEntriesByPath.clear();
    this.inspectByPath.clear();
  }

  inspectFresh(value: string): Promise<'missing' | 'file' | 'directory'> {
    return this.raw.inspect(value);
  }

  readPathMetadataFresh(value: string): Promise<ProjectWorkspacePathMetadata> | undefined {
    return this.raw.readPathMetadata?.(value);
  }

  listDirectoryFresh(value: string): Promise<readonly string[]> {
    return this.raw.listDirectory(value);
  }

  private invalidateAbsolute(value: string): void {
    const absolute = this.key(value);
    const invalidateDescendants = <T>(cache: Map<string, T>) => {
      for (const key of cache.keys()) if (this.isSameOrDescendant(absolute, key)) cache.delete(key);
    };
    invalidateDescendants(this.textByPath);
    invalidateDescendants(this.revisionByPath);
    invalidateDescendants(this.inspectByPath);
    invalidateDescendants(this.directoryEntriesByPath);
    invalidateDescendants(this.realpathByPath);

    let ancestor = this.key(this.dirname(absolute));
    while (true) {
      this.directoryEntriesByPath.delete(ancestor);
      const parent = this.key(this.dirname(ancestor));
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }

  private isSameOrDescendant(parent: string, candidate: string): boolean {
    if (this.key(parent) === this.key(candidate)) return true;
    const relative = this.raw.relativePath(parent, candidate).replaceAll('\\', '/');
    return (
      relative === '' ||
      (relative !== '..' &&
        !relative.startsWith('../') &&
        !relative.startsWith('/') &&
        !/^[A-Za-z]:\//.test(relative))
    );
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
    this.invalidateAbsolute(value);
  }
  async writeBytesAtomic(value: string, bytes: Uint8Array): Promise<void> {
    await this.raw.writeBytesAtomic(value, bytes);
    this.invalidateAbsolute(value);
  }
  async movePathAtomic(from: string, to: string): Promise<void> {
    await this.raw.movePathAtomic(from, to);
    this.invalidateAbsolute(from);
    this.invalidateAbsolute(to);
  }
  async removeFile(value: string): Promise<void> {
    await this.raw.removeFile(value);
    this.invalidateAbsolute(value);
  }
  async createDirectory(value: string): Promise<void> {
    await this.raw.createDirectory(value);
    this.invalidateAbsolute(value);
  }
  async createDirectoryExclusive(value: string): Promise<boolean> {
    const created = await this.raw.createDirectoryExclusive(value);
    if (created) this.invalidateAbsolute(value);
    return created;
  }
  async removeDirectory(value: string): Promise<void> {
    await this.raw.removeDirectory(value);
    this.invalidateAbsolute(value);
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
export type ResidentProjectWorkspaceCoherence = 'coherent' | 'resync-needed' | 'invalid';

export interface ResidentProjectGenerationIdentity {
  readonly sessionEpoch: number;
  readonly generation: number;
}

let nextResidentProjectSessionEpoch = 1;

export interface InvalidAuthoringSourceBlock {
  readonly files: readonly string[];
  readonly ownerPaths: readonly string[];
}

type AuthoringFileStamp =
  | Readonly<{
      kind: 'metadata';
      byteSize: number;
      mtimeNanoseconds: string;
    }>
  | Readonly<{
      kind: 'revision';
      contentHash: `sha256:${string}`;
      byteSize: number;
    }>;

function hasFileSystemErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function sameAuthoringFileStamp(
  previous: AuthoringFileStamp | null | undefined,
  current: AuthoringFileStamp | null,
): boolean {
  if (previous === undefined) return false;
  if (previous === null || current === null) return previous === current;
  if (previous.kind !== current.kind) return false;
  if (previous.kind === 'metadata' && current.kind === 'metadata')
    return (
      previous.byteSize === current.byteSize &&
      previous.mtimeNanoseconds === current.mtimeNanoseconds
    );
  if (previous.kind === 'revision' && current.kind === 'revision')
    return previous.byteSize === current.byteSize && previous.contentHash === current.contentHash;
  return false;
}

export class ResidentProjectWorkspaceSession {
  private readonly fileSystem: ResidentProjectWorkspaceFileSystem;
  private readonly workspace: ProjectWorkspaceService;
  private readonly sessionEpochValue: number;
  private generationValue: number;
  private snapshotValue: LoadedProjectWorkspaceSnapshot;
  private editorStateValue: EditorProjectState;
  private openedValue: Extract<ProjectWorkspaceOpenResult, { ok: true }> | null;
  private mutationTail: Promise<void> = Promise.resolve();
  private coherenceValue: ResidentProjectWorkspaceCoherence = 'coherent';
  private readonly authoringFileStamps = new Map<string, AuthoringFileStamp | null>();
  private readonly invalidAuthoringSourcePaths = new Set<string>();

  protected constructor(
    snapshot: LoadedProjectWorkspaceSnapshot,
    editorState: EditorProjectState,
    host: ResidentProjectWorkspaceSessionHost,
    opened: Extract<ProjectWorkspaceOpenResult, { ok: true }> | null = null,
    identity?: ResidentProjectGenerationIdentity,
  ) {
    this.sessionEpochValue = identity?.sessionEpoch ?? nextResidentProjectSessionEpoch++;
    this.generationValue = identity?.generation ?? 1;
    if (identity)
      nextResidentProjectSessionEpoch = Math.max(
        nextResidentProjectSessionEpoch,
        identity.sessionEpoch + 1,
      );
    this.snapshotValue = snapshot;
    this.editorStateValue = editorState;
    this.openedValue = opened;
    this.fileSystem = new ResidentProjectWorkspaceFileSystem(host.fileSystem);
    this.workspace = host.createWorkspaceService
      ? host.createWorkspaceService(this.fileSystem)
      : new ProjectWorkspaceService(this.fileSystem);
    if (opened) this.fileSystem.seedOpened(opened);
    else this.fileSystem.seed(snapshot);
  }

  static fromOpenedWithHost(
    opened: Extract<ProjectWorkspaceOpenResult, { ok: true }>,
    host: ResidentProjectWorkspaceSessionHost,
    identity?: ResidentProjectGenerationIdentity,
  ): ResidentProjectWorkspaceSession {
    return new ResidentProjectWorkspaceSession(
      opened.snapshot,
      opened.editorState,
      host,
      opened,
      identity,
    );
  }

  static fromSnapshotWithHost(
    snapshot: LoadedProjectWorkspaceSnapshot,
    editorState: EditorProjectState,
    host: ResidentProjectWorkspaceSessionHost,
    identity?: ResidentProjectGenerationIdentity,
  ): ResidentProjectWorkspaceSession {
    return new ResidentProjectWorkspaceSession(snapshot, editorState, host, null, identity);
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

  openedGeneration(): Extract<ProjectWorkspaceOpenResult, { ok: true }> | null {
    return this.openedValue;
  }

  generationIdentity(): ResidentProjectGenerationIdentity {
    return Object.freeze({
      sessionEpoch: this.sessionEpochValue,
      generation: this.generationValue,
    });
  }

  advanceAuthorityGeneration(): Extract<ProjectWorkspaceOpenResult, { ok: true }> | null {
    this.generationValue += 1;
    if (!this.openedValue) return null;
    const snapshot = Object.freeze({
      ...this.openedValue.snapshot,
    }) as LoadedProjectWorkspaceSnapshot;
    this.snapshotValue = snapshot;
    this.openedValue = { ...this.openedValue, snapshot };
    return this.openedValue;
  }

  isGeneration(identity: ResidentProjectGenerationIdentity): boolean {
    return (
      identity.sessionEpoch === this.sessionEpochValue &&
      identity.generation === this.generationValue
    );
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

  coherenceState(): ResidentProjectWorkspaceCoherence {
    return this.coherenceValue;
  }

  markResyncNeeded(): void {
    this.coherenceValue = 'resync-needed';
  }

  recordInvalidAuthoringSources(relativePaths: readonly string[]): void {
    if (relativePaths.length === 0) this.invalidAuthoringSourcePaths.add('*');
    else
      relativePaths.forEach((relativePath) => this.invalidAuthoringSourcePaths.add(relativePath));
    this.coherenceValue = 'invalid';
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

  async captureAuthoringValidationAuthority(): Promise<ProjectSourceInventory | null> {
    return captureAuthoringValidationAuthorityInputs(this.fileSystem, this.snapshotValue);
  }

  async readFreshRevision(relativePath: string): Promise<`sha256:${string}` | 'absent'> {
    const absolute = this.fileSystem.joinPath(this.snapshotValue.projectRoot, relativePath);
    if ((await this.fileSystem.inspectFresh(absolute)) !== 'file') return 'absent';
    try {
      return (await this.fileSystem.readFileRevision(absolute)).contentHash;
    } catch (error) {
      if (
        hasFileSystemErrorCode(error, 'ENOENT') ||
        (await this.fileSystem.inspectFresh(absolute)) === 'missing'
      )
        return 'absent';
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
          if (
            !hasFileSystemErrorCode(error, 'ENOENT') &&
            (await this.fileSystem.inspectFresh(absolute)) !== 'missing'
          )
            throw error;
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

  invalidateCachedProjectState(): void {
    this.fileSystem.invalidate(this.snapshotValue.projectRoot, '');
    this.fileSystem.invalidateInventory();
  }

  adopt(
    snapshot: LoadedProjectWorkspaceSnapshot,
    editorState: EditorProjectState,
    projectionPaths?: readonly string[],
  ): void {
    if (snapshot.projectRoot !== this.snapshotValue.projectRoot)
      throw new Error('Active workspace snapshot belongs to a different project root.');
    if (snapshot !== this.snapshotValue) this.generationValue += 1;
    this.snapshotValue = snapshot;
    this.editorStateValue = editorState;
    this.openedValue = null;
    if (projectionPaths) this.fileSystem.adoptProjection(snapshot, projectionPaths);
    else this.fileSystem.seed(snapshot);
  }

  adoptOpened(
    opened: Extract<ProjectWorkspaceOpenResult, { ok: true }>,
    options: Readonly<{
      preserveInvalidOverlay?: boolean;
      projectionPaths?: readonly string[];
    }> = {},
  ): void {
    const invalidAuthoringSourcePaths = options.preserveInvalidOverlay
      ? [...this.invalidAuthoringSourcePaths]
      : [];
    this.adopt(opened.snapshot, opened.editorState, options.projectionPaths);
    this.openedValue = opened;
    this.invalidAuthoringSourcePaths.clear();
    invalidAuthoringSourcePaths.forEach((relativePath) =>
      this.invalidAuthoringSourcePaths.add(relativePath),
    );
    this.coherenceValue = invalidAuthoringSourcePaths.length > 0 ? 'invalid' : 'coherent';
  }

  rehydrateOpened(opened: Extract<ProjectWorkspaceOpenResult, { ok: true }>): void {
    if (
      opened.snapshot.projectRoot !== this.snapshotValue.projectRoot ||
      opened.snapshot.workspaceRevision !== this.snapshotValue.workspaceRevision ||
      opened.snapshot.sourceRevision !== this.snapshotValue.sourceRevision
    )
      throw new Error(
        'Rehydrated Project generation does not match the portable snapshot identity.',
      );
    this.snapshotValue = opened.snapshot;
    this.editorStateValue = opened.editorState;
    this.openedValue = opened;
    this.fileSystem.seed(opened.snapshot);
    this.invalidAuthoringSourcePaths.clear();
    this.coherenceValue = 'coherent';
  }

  private async fileStamp(relativePath: string): Promise<AuthoringFileStamp | null> {
    const absolute = this.fileSystem.joinPath(this.snapshotValue.projectRoot, relativePath);
    const metadata = await this.fileSystem.readPathMetadataFresh(absolute);
    if (metadata) {
      if (metadata.kind === 'missing' || metadata.kind === 'directory' || metadata.kind === 'other')
        return null;
      if (
        metadata.kind === 'file' &&
        metadata.byteSize !== undefined &&
        metadata.mtimeNanoseconds !== undefined
      ) {
        return {
          kind: 'metadata',
          byteSize: metadata.byteSize,
          mtimeNanoseconds: metadata.mtimeNanoseconds,
        };
      }
    }
    if ((await this.fileSystem.inspectFresh(absolute)) !== 'file') return null;
    try {
      const revision = await this.fileSystem.readFileRevision(absolute);
      return { kind: 'revision', ...revision };
    } catch (error) {
      if (
        hasFileSystemErrorCode(error, 'ENOENT') ||
        (await this.fileSystem.inspectFresh(absolute)) === 'missing'
      )
        return null;
      throw error;
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
      if (!sameAuthoringFileStamp(previous, current)) suspicious.add(relativePath);
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
    const transactionsRoot = this.fileSystem.joinPath(
      this.snapshotValue.projectRoot,
      '.noveltea',
      'transactions',
    );
    if ((await this.fileSystem.inspectFresh(transactionsRoot)) === 'missing')
      return { recovered: false, changedPaths: [] };
    const entries = await this.fileSystem.listDirectoryFresh(transactionsRoot);
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
      else if (file === 'i18n' || file.startsWith('i18n/')) invalidOwnerPaths.add('/localization');
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

  invalidSourceBlockForSemanticPaths(
    requiredPaths: readonly string[],
  ): InvalidAuthoringSourceBlock | null {
    return this.invalidSourceBlockForMutation([], requiredPaths);
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
