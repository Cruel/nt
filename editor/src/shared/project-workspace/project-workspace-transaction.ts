import { sha256PrefixedBytes } from '../web-crypto';
import {
  assertProjectWorkspacePathContained,
  type ProjectWorkspaceFileSystem,
  type ProjectWorkspaceProcessLiveness,
} from './project-workspace-file-system';

export const PROJECT_WORKSPACE_TRANSACTION_SCHEMA = 'noveltea.workspace.transaction' as const;
export const PROJECT_WORKSPACE_ABSENT_REVISION = 'absent' as const;

export type ProjectWorkspaceExpectedRevision = `sha256:${string}` | 'absent';

export interface ProjectWorkspaceTransactionTargetInput {
  readonly path: string;
  readonly operation: 'write' | 'delete';
  readonly expectedRevision: ProjectWorkspaceExpectedRevision;
  readonly bytes?: Uint8Array;
}

export interface ProjectWorkspaceTransactionRequest {
  readonly transactionId?: string;
  readonly operationLabel: string;
  readonly targets: readonly ProjectWorkspaceTransactionTargetInput[];
}

interface JournalTarget {
  path: string;
  operation: 'write' | 'delete';
  beforeRevision: ProjectWorkspaceExpectedRevision;
  afterRevision: ProjectWorkspaceExpectedRevision;
  beforeBlob: string | null;
  afterBlob: string | null;
}

interface JournalManifest {
  schema: typeof PROJECT_WORKSPACE_TRANSACTION_SCHEMA;
  transactionId: string;
  state: 'prepared' | 'writing' | 'committed' | 'rolled-back';
  writerOwnerToken: string;
  writerPid: number;
  operationLabel: string;
  targets: JournalTarget[];
  completedTargets: string[];
}

interface LockOwner {
  ownerToken: string;
  pid: number;
  operationLabel: string;
  transactionId: string | null;
}

export class ProjectWorkspaceMutationError extends Error {
  constructor(
    readonly code:
      | 'WORKSPACE_BUSY'
      | 'WORKSPACE_REVISION_CONFLICT'
      | 'WORKSPACE_TRANSACTION_RECOVERY_CONFLICT'
      | 'WORKSPACE_PATH_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectWorkspaceMutationError';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const transactionsPath = '.noveltea/transactions';
const lockPath = `${transactionsPath}/.writer-lock`;
const reclaimGuardPath = `${transactionsPath}/.writer-lock-reclaim`;
const claimedLockPrefix = '.writer-lock.claimed-';

const compareCodePoints = (left: string, right: string): number => {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
};

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/.test(value) &&
    value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function validRevision(value: unknown): value is ProjectWorkspaceExpectedRevision {
  return value === 'absent' || (typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value));
}

type ParsedLockOwner =
  | { readonly valid: true; readonly owner: LockOwner }
  | { readonly valid: false };

function parseOwner(value: unknown): ParsedLockOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false };
  const owner = value as Record<string, unknown>;
  if (
    typeof owner.ownerToken !== 'string' ||
    owner.ownerToken.length === 0 ||
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) <= 0 ||
    typeof owner.operationLabel !== 'string' ||
    !(owner.transactionId === null || typeof owner.transactionId === 'string')
  )
    return { valid: false };
  return { valid: true, owner: owner as unknown as LockOwner };
}

function createTransactionId(override?: () => string): string {
  return override === undefined ? globalThis.crypto.randomUUID() : override();
}

function parseManifest(value: unknown, expectedId: string): JournalManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const manifest = value as Record<string, unknown>;
  if (
    manifest.schema !== PROJECT_WORKSPACE_TRANSACTION_SCHEMA ||
    manifest.transactionId !== expectedId ||
    !['prepared', 'writing', 'committed', 'rolled-back'].includes(String(manifest.state)) ||
    typeof manifest.writerOwnerToken !== 'string' ||
    !Number.isSafeInteger(manifest.writerPid) ||
    typeof manifest.operationLabel !== 'string' ||
    !Array.isArray(manifest.targets) ||
    !Array.isArray(manifest.completedTargets)
  )
    return null;
  for (const target of manifest.targets) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
    const item = target as Record<string, unknown>;
    if (
      typeof item.path !== 'string' ||
      !isSafeRelativePath(item.path) ||
      !['write', 'delete'].includes(String(item.operation)) ||
      !validRevision(item.beforeRevision) ||
      !validRevision(item.afterRevision) ||
      !(item.beforeBlob === null || typeof item.beforeBlob === 'string') ||
      !(item.afterBlob === null || typeof item.afterBlob === 'string')
    )
      return null;
  }
  if (!manifest.completedTargets.every((path) => typeof path === 'string')) return null;
  return manifest as unknown as JournalManifest;
}

async function revisionAt(
  fileSystem: ProjectWorkspaceFileSystem,
  absolutePath: string,
): Promise<ProjectWorkspaceExpectedRevision> {
  if ((await fileSystem.inspect(absolutePath)) === 'missing')
    return PROJECT_WORKSPACE_ABSENT_REVISION;
  return (await fileSystem.readFileRevision(absolutePath)).contentHash;
}

export class ProjectWorkspaceTransactionService {
  constructor(
    private readonly fileSystem: ProjectWorkspaceFileSystem,
    private readonly processLiveness: ProjectWorkspaceProcessLiveness,
    private readonly pid: number,
    private readonly createIdOverride?: () => string,
  ) {}

  async recover(projectRoot: string): Promise<void> {
    const transactionRoot = this.absolute(projectRoot, transactionsPath);
    const entries = await this.fileSystem.listDirectory(transactionRoot);
    // A clean read-only workspace has nothing to recover. Avoid manufacturing a writer lock merely
    // to prove the empty transaction directory is empty; this also keeps read-only validation free
    // of unnecessary filesystem mutations across CLI hosts.
    if (entries.length === 0) return;
    const lock = await this.acquireLock(projectRoot, 'workspace recovery', null, false);
    try {
      await this.recoverJournals(projectRoot);
    } finally {
      await this.releaseLock(projectRoot, lock);
    }
  }

  commit(
    projectRoot: string,
    request: ProjectWorkspaceTransactionRequest,
  ): Promise<{ transactionId: string }> {
    return new Promise<{ transactionId: string }>((resolve, reject) => {
      void (async () => {
        try {
          const transactionId = request.transactionId ?? createTransactionId(this.createIdOverride);
          if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(transactionId))
            throw new ProjectWorkspaceMutationError(
              'WORKSPACE_PATH_INVALID',
              'Workspace transaction ID is invalid.',
            );
          const lock = await this.acquireLock(
            projectRoot,
            request.operationLabel,
            transactionId,
            true,
          );
          let released = false;
          const directory = `${transactionsPath}/${transactionId}`;
          try {
            await this.recoverJournals(projectRoot);
            if (request.targets.length === 0) {
              await this.releaseLock(projectRoot, lock);
              released = true;
              resolve({ transactionId });
              return;
            }
            const targets = [...request.targets].sort((left, right) =>
              compareCodePoints(left.path, right.path),
            );
            if (new Set(targets.map((target) => target.path)).size !== targets.length)
              throw new ProjectWorkspaceMutationError(
                'WORKSPACE_PATH_INVALID',
                'A workspace transaction cannot target one path more than once.',
              );
            await this.fileSystem.createDirectory(this.absolute(projectRoot, directory));
            const journalTargets: JournalTarget[] = [];
            let manifest: JournalManifest = {
              schema: PROJECT_WORKSPACE_TRANSACTION_SCHEMA,
              transactionId,
              state: 'prepared',
              writerOwnerToken: lock.ownerToken,
              writerPid: this.pid,
              operationLabel: request.operationLabel,
              targets: journalTargets,
              completedTargets: [],
            };
            try {
              for (let index = 0; index < targets.length; index += 1) {
                const target = targets[index]!;
                if (
                  !isSafeRelativePath(target.path) ||
                  (target.operation === 'write' && !target.bytes)
                )
                  throw new ProjectWorkspaceMutationError(
                    'WORKSPACE_PATH_INVALID',
                    `Workspace transaction target '${target.path}' is invalid.`,
                  );
                const absolute = this.absolute(projectRoot, target.path);
                await assertProjectWorkspacePathContained(this.fileSystem, projectRoot, absolute);
                const beforeRevision = await revisionAt(this.fileSystem, absolute);
                if (beforeRevision !== target.expectedRevision)
                  throw new ProjectWorkspaceMutationError(
                    'WORKSPACE_REVISION_CONFLICT',
                    `Workspace source '${target.path}' changed before commit.`,
                  );
                const beforeBlob = beforeRevision === 'absent' ? null : `before/${index}`;
                const afterBlob = target.operation === 'write' ? `after/${index}` : null;
                if (beforeBlob)
                  await this.writeStaged(
                    projectRoot,
                    directory,
                    beforeBlob,
                    await this.fileSystem.readBytes(absolute),
                  );
                if (afterBlob)
                  await this.writeStaged(projectRoot, directory, afterBlob, target.bytes!);
                journalTargets.push({
                  path: target.path,
                  operation: target.operation,
                  beforeRevision,
                  afterRevision:
                    target.operation === 'write'
                      ? await sha256PrefixedBytes(target.bytes!)
                      : 'absent',
                  beforeBlob,
                  afterBlob,
                });
              }
              manifest = { ...manifest, targets: journalTargets };
              await this.writeManifest(projectRoot, manifest);
            } catch (error) {
              await this.fileSystem.removeDirectory(this.absolute(projectRoot, directory));
              throw error;
            }
            try {
              for (const target of journalTargets) {
                const current = await revisionAt(
                  this.fileSystem,
                  this.absolute(projectRoot, target.path),
                );
                if (current !== target.beforeRevision)
                  throw new ProjectWorkspaceMutationError(
                    'WORKSPACE_REVISION_CONFLICT',
                    `Workspace source '${target.path}' changed after staging.`,
                  );
              }
              manifest = { ...manifest, state: 'writing' };
              await this.writeManifest(projectRoot, manifest);
              for (const target of journalTargets) {
                await this.applyState(projectRoot, directory, target, 'after');
                manifest = {
                  ...manifest,
                  completedTargets: [...manifest.completedTargets, target.path],
                };
                await this.writeManifest(projectRoot, manifest);
              }
              manifest = { ...manifest, state: 'committed' };
              await this.writeManifest(projectRoot, manifest);
            } catch (error) {
              await this.restoreBeforeState(projectRoot, directory, manifest);
              manifest = { ...manifest, state: 'rolled-back' };
              await this.writeManifest(projectRoot, manifest);
              await this.fileSystem.removeDirectory(this.absolute(projectRoot, directory));
              throw error;
            }
            await this.fileSystem.removeDirectory(this.absolute(projectRoot, directory));
            await this.releaseLock(projectRoot, lock);
            released = true;
            resolve({ transactionId });
          } finally {
            if (!released) await this.releaseLock(projectRoot, lock);
          }
        } catch (error) {
          reject(error);
        }
      })();
    });
  }

  private absolute(projectRoot: string, relativePath: string): string {
    return this.fileSystem.joinPath(projectRoot, relativePath);
  }

  private async writeStaged(
    projectRoot: string,
    directory: string,
    relativeBlob: string,
    bytes: Uint8Array,
  ) {
    const target = this.absolute(projectRoot, `${directory}/${relativeBlob}`);
    await assertProjectWorkspacePathContained(this.fileSystem, projectRoot, target);
    await this.fileSystem.writeBytesAtomic(target, bytes);
  }

  private async writeManifest(projectRoot: string, manifest: JournalManifest) {
    await this.fileSystem.writeTextAtomic(
      this.absolute(projectRoot, `${transactionsPath}/${manifest.transactionId}/manifest.json`),
      canonicalJson(manifest),
    );
  }

  private acquireLock(
    projectRoot: string,
    operationLabel: string,
    transactionId: string | null,
    recoverExisting: boolean,
  ): Promise<LockOwner> {
    return new Promise<LockOwner>((resolve, reject) => {
      void (async () => {
        let reclaimGuard: LockOwner | null = null;
        let claimedLockPath: string | null = null;
        let claimedOwnerToken: string | null = null;
        let recoveredDuringReclaim = false;
        let activeOwner: LockOwner | null = null;
        try {
          const transactionsAbsolute = this.absolute(projectRoot, transactionsPath);
          try {
            await assertProjectWorkspacePathContained(
              this.fileSystem,
              projectRoot,
              transactionsAbsolute,
            );
          } catch {
            throw new ProjectWorkspaceMutationError(
              'WORKSPACE_PATH_INVALID',
              'The workspace transaction directory escapes the project root.',
            );
          }
          await this.fileSystem.createDirectory(transactionsAbsolute);
          const lockAbsolute = this.absolute(projectRoot, lockPath);
          const reclaimGuardAbsolute = this.absolute(projectRoot, reclaimGuardPath);
          if ((await this.fileSystem.inspect(reclaimGuardAbsolute)) !== 'missing')
            throw new ProjectWorkspaceMutationError(
              'WORKSPACE_BUSY',
              'Another NovelTea process is reclaiming the project writer lock.',
            );

          if (await this.fileSystem.createDirectoryExclusive(lockAbsolute)) {
            // Close the race with a stale-lock reclaimer that acquired its guard after our precheck.
            // We have not published an owner yet, so this empty directory is safe for us to remove.
            if ((await this.fileSystem.inspect(reclaimGuardAbsolute)) !== 'missing') {
              await this.fileSystem.removeDirectory(lockAbsolute);
              throw new ProjectWorkspaceMutationError(
                'WORKSPACE_BUSY',
                'Another NovelTea process is reclaiming the project writer lock.',
              );
            }
          } else {
            const parsed = await this.readLockOwner(projectRoot, lockPath);
            if (!parsed.valid)
              throw new ProjectWorkspaceMutationError(
                'WORKSPACE_BUSY',
                'The project writer lock has no valid owner.',
              );
            const existing = parsed.owner;
            const alive = await this.processLiveness.isProcessAlive(existing.pid);
            if (alive !== false)
              throw new ProjectWorkspaceMutationError(
                'WORKSPACE_BUSY',
                'Another NovelTea process owns the project writer lock.',
              );

            reclaimGuard = {
              ownerToken: createTransactionId(this.createIdOverride),
              pid: this.pid,
              operationLabel: `reclaim ${operationLabel}`,
              transactionId,
            };
            if (!(await this.fileSystem.createDirectoryExclusive(reclaimGuardAbsolute)))
              throw new ProjectWorkspaceMutationError(
                'WORKSPACE_BUSY',
                'Another NovelTea process is reclaiming the project writer lock.',
              );
            await this.fileSystem.writeTextAtomic(
              this.absolute(projectRoot, `${reclaimGuardPath}/owner.json`),
              canonicalJson(reclaimGuard),
            );

            // The owner may have changed between the first stale observation and our exclusive
            // reclaim guard. Revalidate both identity and liveness before touching the lock path.
            const guarded = await this.readLockOwner(projectRoot, lockPath);
            if (!guarded.valid || guarded.owner.ownerToken !== existing.ownerToken)
              throw new ProjectWorkspaceMutationError(
                'WORKSPACE_BUSY',
                'The project writer lock changed before stale-lock reclamation.',
              );
            if ((await this.processLiveness.isProcessAlive(guarded.owner.pid)) !== false)
              throw new ProjectWorkspaceMutationError(
                'WORKSPACE_BUSY',
                'The project writer lock owner became live before reclamation.',
              );

            const claimId = createTransactionId(this.createIdOverride);
            const nextClaimedLockPath = `${transactionsPath}/${claimedLockPrefix}${claimId}`;
            const nextClaimedOwnerToken = guarded.owner.ownerToken;
            try {
              await this.fileSystem.movePathAtomic(
                lockAbsolute,
                this.absolute(projectRoot, nextClaimedLockPath),
              );
            } catch {
              throw new ProjectWorkspaceMutationError(
                'WORKSPACE_BUSY',
                'The project writer lock changed during stale-lock reclamation.',
              );
            }
            claimedLockPath = nextClaimedLockPath;
            claimedOwnerToken = nextClaimedOwnerToken;
            const claimed = await this.readLockOwner(projectRoot, claimedLockPath);
            if (!claimed.valid || claimed.owner.ownerToken !== claimedOwnerToken) {
              if (await this.restoreClaimedLock(projectRoot, claimedLockPath, claimedOwnerToken)) {
                claimedLockPath = null;
                claimedOwnerToken = null;
              }
              throw new ProjectWorkspaceMutationError(
                'WORKSPACE_BUSY',
                'The project writer lock changed during stale-lock reclamation.',
              );
            }

            // The reclaim guard blocks all compliant writers while the active lock path is absent.
            // Only the process that atomically moved the stale lock here may recover journals.
            await this.recoverJournals(projectRoot);
            recoveredDuringReclaim = true;
            if (!(await this.fileSystem.createDirectoryExclusive(lockAbsolute)))
              throw new ProjectWorkspaceMutationError(
                'WORKSPACE_BUSY',
                'The project writer lock was acquired during stale-lock reclamation.',
              );
          }

          activeOwner = {
            ownerToken: createTransactionId(this.createIdOverride),
            pid: this.pid,
            operationLabel,
            transactionId,
          };
          await this.fileSystem.writeTextAtomic(
            this.absolute(projectRoot, `${lockPath}/owner.json`),
            canonicalJson(activeOwner),
          );
          if (claimedLockPath && claimedOwnerToken) {
            if (!(await this.removeOwnedDirectory(projectRoot, claimedLockPath, claimedOwnerToken)))
              throw new ProjectWorkspaceMutationError(
                'WORKSPACE_BUSY',
                'The claimed stale writer lock changed before reclamation cleanup.',
              );
            claimedLockPath = null;
            claimedOwnerToken = null;
          }
          if (reclaimGuard) {
            if (
              !(await this.removeOwnedDirectory(
                projectRoot,
                reclaimGuardPath,
                reclaimGuard.ownerToken,
              ))
            )
              throw new ProjectWorkspaceMutationError(
                'WORKSPACE_BUSY',
                'The writer-lock reclaim guard changed before cleanup.',
              );
            reclaimGuard = null;
          }
          if (recoverExisting && !recoveredDuringReclaim) await this.recoverJournals(projectRoot);
          resolve(activeOwner);
        } catch (error) {
          if (activeOwner) await this.releaseLock(projectRoot, activeOwner);
          let claimedStateRestored = true;
          if (claimedLockPath && claimedOwnerToken)
            claimedStateRestored = await this.restoreClaimedLock(
              projectRoot,
              claimedLockPath,
              claimedOwnerToken,
            );
          if (reclaimGuard && claimedStateRestored)
            await this.removeOwnedDirectory(projectRoot, reclaimGuardPath, reclaimGuard.ownerToken);
          reject(error);
        }
      })();
    });
  }

  private readLockOwner(projectRoot: string, relativeLockPath: string): Promise<ParsedLockOwner> {
    return new Promise<ParsedLockOwner>((resolve) => {
      void (async () => {
        try {
          resolve(
            parseOwner(
              JSON.parse(
                await this.fileSystem.readText(
                  this.absolute(projectRoot, `${relativeLockPath}/owner.json`),
                ),
              ),
            ),
          );
        } catch {
          resolve({ valid: false });
        }
      })();
    });
  }

  private async removeOwnedDirectory(
    projectRoot: string,
    relativePath: string,
    expectedOwnerToken: string,
  ): Promise<boolean> {
    const parsed = await this.readLockOwner(projectRoot, relativePath);
    if (!parsed.valid || parsed.owner.ownerToken !== expectedOwnerToken) return false;
    await this.fileSystem.removeDirectory(this.absolute(projectRoot, relativePath));
    return true;
  }

  private async restoreClaimedLock(
    projectRoot: string,
    claimedPath: string,
    expectedOwnerToken: string,
  ): Promise<boolean> {
    const parsed = await this.readLockOwner(projectRoot, claimedPath);
    if (!parsed.valid || parsed.owner.ownerToken !== expectedOwnerToken) return false;
    const active = this.absolute(projectRoot, lockPath);
    if ((await this.fileSystem.inspect(active)) !== 'missing') return false;
    try {
      await this.fileSystem.movePathAtomic(this.absolute(projectRoot, claimedPath), active);
      return true;
    } catch {
      // Leave the reclaim guard and claimed lock in place so later mutation fails closed rather than
      // deleting an ownership state that can no longer be proven safe to restore.
      return false;
    }
  }

  private async releaseLock(projectRoot: string, owner: LockOwner) {
    await this.removeOwnedDirectory(projectRoot, lockPath, owner.ownerToken);
  }

  private recoverJournals(projectRoot: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      void (async () => {
        try {
          const root = this.absolute(projectRoot, transactionsPath);
          for (const entry of [...(await this.fileSystem.listDirectory(root))].sort(
            compareCodePoints,
          )) {
            if (
              entry === '.writer-lock' ||
              entry === '.writer-lock-reclaim' ||
              entry.startsWith(claimedLockPrefix)
            )
              continue;
            const directory = `${transactionsPath}/${entry}`;
            let manifest: JournalManifest | null = null;
            try {
              manifest = parseManifest(
                JSON.parse(
                  await this.fileSystem.readText(
                    this.absolute(projectRoot, `${directory}/manifest.json`),
                  ),
                ),
                entry,
              );
            } catch {
              // Invalid journals are retained for explicit intervention.
            }
            if (manifest === null)
              throw new ProjectWorkspaceMutationError(
                'WORKSPACE_TRANSACTION_RECOVERY_CONFLICT',
                `Transaction '${entry}' has no valid current manifest.`,
              );
            await this.assertKnownTargetStates(projectRoot, manifest);
            if (manifest.state === 'committed') {
              for (const target of manifest.targets)
                await this.recoverTarget(projectRoot, directory, target, 'after');
            } else if (manifest.state === 'rolled-back') {
              for (const target of manifest.targets) {
                if (
                  (await revisionAt(this.fileSystem, this.absolute(projectRoot, target.path))) !==
                  target.beforeRevision
                )
                  throw this.recoveryConflict(target.path);
              }
            } else {
              await this.restoreBeforeState(projectRoot, directory, manifest);
              await this.writeManifest(projectRoot, { ...manifest, state: 'rolled-back' });
            }
            await this.fileSystem.removeDirectory(this.absolute(projectRoot, directory));
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      })();
    });
  }

  private async restoreBeforeState(
    projectRoot: string,
    directory: string,
    manifest: JournalManifest,
  ) {
    await this.assertKnownTargetStates(projectRoot, manifest);
    for (const target of [...manifest.targets].reverse())
      await this.recoverTarget(projectRoot, directory, target, 'before');
  }

  private async assertKnownTargetStates(projectRoot: string, manifest: JournalManifest) {
    for (const target of manifest.targets) {
      const current = await revisionAt(this.fileSystem, this.absolute(projectRoot, target.path));
      if (manifest.state === 'rolled-back') {
        if (current !== target.beforeRevision) throw this.recoveryConflict(target.path);
      } else if (current !== target.beforeRevision && current !== target.afterRevision)
        throw this.recoveryConflict(target.path);
    }
  }

  private async recoverTarget(
    projectRoot: string,
    directory: string,
    target: JournalTarget,
    desired: 'before' | 'after',
  ) {
    const absolute = this.absolute(projectRoot, target.path);
    const current = await revisionAt(this.fileSystem, absolute);
    const desiredRevision = desired === 'before' ? target.beforeRevision : target.afterRevision;
    const alternateRevision = desired === 'before' ? target.afterRevision : target.beforeRevision;
    if (current === desiredRevision) return;
    if (current !== alternateRevision) throw this.recoveryConflict(target.path);
    await this.applyState(projectRoot, directory, target, desired);
  }

  private async applyState(
    projectRoot: string,
    directory: string,
    target: JournalTarget,
    desired: 'before' | 'after',
  ) {
    const absolute = this.absolute(projectRoot, target.path);
    const revision = desired === 'before' ? target.beforeRevision : target.afterRevision;
    const blob = desired === 'before' ? target.beforeBlob : target.afterBlob;
    await assertProjectWorkspacePathContained(this.fileSystem, projectRoot, absolute);
    if (revision === 'absent') await this.fileSystem.removeFile(absolute);
    else {
      if (!blob || !isSafeRelativePath(blob)) throw this.recoveryConflict(target.path);
      const bytes = await this.fileSystem.readBytes(
        this.absolute(projectRoot, `${directory}/${blob}`),
      );
      if ((await sha256PrefixedBytes(bytes)) !== revision) throw this.recoveryConflict(target.path);
      await this.fileSystem.writeBytesAtomic(absolute, bytes);
    }
  }

  private recoveryConflict(path: string) {
    return new ProjectWorkspaceMutationError(
      'WORKSPACE_TRANSACTION_RECOVERY_CONFLICT',
      `Transaction recovery found an unknown concurrent state at '${path}'.`,
    );
  }
}

export const utf8WorkspaceTransactionTarget = (
  path: string,
  expectedRevision: ProjectWorkspaceExpectedRevision,
  text: string,
): ProjectWorkspaceTransactionTargetInput => ({
  path,
  operation: 'write',
  expectedRevision,
  bytes: encoder.encode(text),
});

export const decodeWorkspaceTransactionBytes = (bytes: Uint8Array) => decoder.decode(bytes);
