import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  cp,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { encodeStructuredYaml } from '../../shared/project-workspace/structured-yaml-source';
import {
  WORKING_SOURCE_ROOT,
  WORKING_SOURCE_SCHEMA,
  workingSourceForNativeOwner,
  workingSourceBaselinePath,
  workingSourceManifestSchema,
  workingSourcePaths,
  type WorkingSourceManifest,
} from '../../shared/project-workspace/working-source-contract';
import type { NativeDirtyCheckpoint } from './native-authoring-working-project';
import type { nativeAuthoringSnapshotSchema } from './native-authoring-worker-contract';
import type { z } from 'zod';

type Snapshot = z.infer<typeof nativeAuthoringSnapshotSchema>;
type SourceSnapshot = NonNullable<Snapshot['recordSnapshots']>[string];
type Entry = WorkingSourceManifest['entries'][string];
type NativeFileExchange = (
  staged: string,
  destination: string,
  backup: string,
) => string | Promise<string>;
type Projection = {
  representation: Entry['representation'];
  source?: Record<string, unknown>;
  bytes?: Buffer;
  pending?: Buffer;
  diskRevision: string;
  checkpointRevision: string;
};
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const bytesLimit = 4 * 1024 * 1024;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function pendingOwner(field: string): string | null {
  const parts = field.split('/');
  if (parts[0] !== '' || parts.length < 3) return null;
  if (
    [
      'project',
      'settings',
      'export',
      'entrypoint',
      'bootstrapModule',
      'interactableInstances',
      'prefetchHints',
    ].includes(parts[1]!)
  )
    return 'project.yaml';
  if (parts[1] === 'editor') return 'editor.yaml';
  if (parts[1] === 'traits') return 'traits.yaml';
  if (parts[1] === 'localization') {
    if (parts[2] === 'translations' && parts[3])
      return workingSourceForNativeOwner(`i18n/locales/${parts[3]}.yaml`);
    if (parts[2] === 'assets' && parts[3])
      return workingSourceForNativeOwner(`i18n/assets/${parts[3]}.yaml`);
    if (parts[2] === 'sourceMessageTracking') return 'i18n/tracking.yaml';
    if (parts[2] === 'orphanedMessages') return 'i18n/orphans.yaml';
    if (parts[2] === 'usageNotes') return 'i18n/usage-notes.yaml';
    // The localization root can own several physical fragments; never guess one.
    return null;
  }
  if (!parts[2]) return null;
  return workingSourceForNativeOwner(`${parts[1]}/${parts[2]}`);
}

/** Snapshot and checkpoint are both captured *after* the durable native acknowledgment. */
export function nativeWorkingSourceProjection(
  snapshot: Snapshot,
  checkpoint: NativeDirtyCheckpoint,
): Map<string, Projection> {
  const result = new Map<string, Projection>();
  const sources: [string, SourceSnapshot][] = [
    ['project', snapshot],
    ...Object.entries(snapshot.recordSnapshots ?? {}),
  ];
  for (const [owner, state] of sources) {
    if (!state.dirtyPatches.length) continue;
    const relative = workingSourceForNativeOwner(owner);
    if (!relative) throw new Error(`Native working owner is not a supported source: ${owner}`);
    const evidence = checkpoint.ownerEvidence?.[owner];
    if (state.source === null || typeof state.source !== 'object' || Array.isArray(state.source))
      throw new Error(`Native working owner has no source mapping: ${owner}`);
    result.set(relative, {
      representation: 'file',
      // Render against exact saved bytes later so unchanged comments and sparse nodes survive.
      source: state.source as Record<string, unknown>,
      diskRevision: state.diskSourceRevision,
      checkpointRevision: digest(
        Buffer.from(
          JSON.stringify({
            patches: state.dirtyPatches,
            evidence,
          }),
        ),
      ),
    });
  }
  for (const [owner, source] of Object.entries(checkpoint.textSources)) {
    const relative = workingSourceForNativeOwner(owner);
    if (!relative) throw new Error(`Native working text is not a supported source: ${owner}`);
    result.set(relative, {
      representation: 'file',
      bytes: Buffer.from(source.text),
      diskRevision: source.diskRevision,
      checkpointRevision: digest(Buffer.from(JSON.stringify(source))),
    });
  }
  for (const batch of checkpoint.batches) {
    for (const operation of batch.patches) {
      if (operation.operation !== 'remove') continue;
      const match = /^\/([^/]+)\/([^/]+)$/.exec(operation.path);
      if (!match) continue;
      const owner = `${match[1]}/${match[2]}`;
      const relative = workingSourceForNativeOwner(owner);
      if (!relative || result.has(relative) || !batch.diskPreconditions[owner]) continue;
      result.set(relative, {
        representation: 'deleted',
        bytes: Buffer.from('{"deleted":true}\n'),
        diskRevision: batch.diskPreconditions[owner],
        // A batched edit may touch other owners. Their new patches must not
        // cause this deletion marker to be republished on every keystroke.
        checkpointRevision: digest(
          Buffer.from(JSON.stringify({ operation, diskRevision: batch.diskPreconditions[owner] })),
        ),
      });
    }
  }
  const fields = new Map<string, Record<string, string>>();
  for (const [field, text] of Object.entries(checkpoint.pendingFields)) {
    const owner = pendingOwner(field);
    if (!owner) throw new Error(`Unrepresentable native pending field: ${field}`);
    const group = fields.get(owner) ?? {};
    group[field] = text;
    fields.set(owner, group);
  }
  for (const [owner, fieldText] of fields) {
    const pending = Buffer.from(JSON.stringify({ fieldText, namedText: {} }));
    const old = result.get(owner);
    if (old) {
      old.pending = pending;
      old.checkpointRevision = digest(
        Buffer.from(
          JSON.stringify({
            previous: old.checkpointRevision,
            fieldText,
          }),
        ),
      );
    } else {
      result.set(owner, {
        representation: 'pending-only',
        pending,
        // The publisher verifies this clean physical owner at materialization time.
        diskRevision: 'absent',
        checkpointRevision: digest(pending),
      });
    }
  }
  return result;
}

async function statSafe(filename: string) {
  try {
    return await lstat(filename);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Restrict *editor-owned* publication, independently of agent harness permissions. */
async function ensureSafeDirectory(root: string, directory: string): Promise<void> {
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Working source escaped Project root.');
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const entry = await statSafe(cursor);
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
      throw new Error(`Unsafe working-source directory: ${cursor}`);
    if (!entry) {
      await mkdir(cursor);
      const created = await statSafe(cursor);
      if (!created?.isDirectory() || created.isSymbolicLink())
        throw new Error(`Unsafe working-source directory: ${cursor}`);
    }
  }
}

async function readSafe(filename: string): Promise<Buffer | null> {
  const entry = await statSafe(filename);
  if (!entry) return null;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > bytesLimit)
    throw new Error(`Unsafe or oversized working-source file: ${filename}`);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.ino !== entry.ino || actual.dev !== entry.dev)
      throw new Error(`Working source changed during inspection: ${filename}`);
    const data = await handle.readFile();
    if (data.byteLength > bytesLimit) throw new Error('Working source exceeds size limit.');
    return data;
  } finally {
    await handle.close();
  }
}

async function readProjectBytes(root: string, owner: string, allowAbsent = false) {
  let current = root;
  const components = owner.split('/');
  for (const segment of components.slice(0, -1)) {
    current = path.join(current, segment);
    const item = await statSafe(current);
    if (!item && allowAbsent) return null;
    if (!item?.isDirectory() || item.isSymbolicLink())
      throw new Error(`Unsafe authored source directory: ${owner}`);
  }
  return readSafe(path.join(root, owner));
}

async function readProjectSource(
  root: string,
  owner: string,
  revision: string,
  sourceRevisionFor: ((bytes: Uint8Array) => string) | undefined,
) {
  const bytes = await readProjectBytes(root, owner, revision === 'absent');
  if (revision === 'absent') {
    if (bytes) throw new Error(`Authored source appeared during publication: ${owner}`);
    return undefined;
  }
  if (!bytes || !sourceRevisionFor || sourceRevisionFor(bytes) !== revision)
    throw new Error(`Authored source changed before projection: ${owner}`);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function syncDirectory(dir: string) {
  if (process.platform === 'win32') return;
  const handle = await open(dir, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(
  root: string,
  filename: string,
  next: Buffer,
  expected: string | null,
  exchange?: NativeFileExchange,
) {
  if (next.byteLength > bytesLimit)
    throw new Error(`Working source exceeds size limit: ${filename}`);
  await ensureSafeDirectory(root, path.dirname(filename));
  const current = await readSafe(filename);
  if ((current ? digest(current) : null) !== expected)
    throw new Error(`Externally modified working source: ${filename}`);
  if (current && current.equals(next)) return;
  const parent = path.dirname(filename);
  const directoryBefore = await statSafe(parent);
  const targetBefore = await statSafe(filename);
  const temporary = path.join(path.dirname(filename), `.working-${randomUUID()}.tmp`);
  let retainedOriginal: string | null = null;
  let exchangeAttempted = false;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(next);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const after = await readSafe(filename);
    if ((after ? digest(after) : null) !== expected)
      throw new Error(`Externally modified working source during publication: ${filename}`);
    const directoryAfter = await statSafe(parent);
    const targetAfter = await statSafe(filename);
    if (
      !directoryBefore ||
      !directoryAfter ||
      directoryBefore.ino !== directoryAfter.ino ||
      directoryBefore.dev !== directoryAfter.dev ||
      directoryAfter.isSymbolicLink() ||
      targetBefore?.ino !== targetAfter?.ino ||
      targetBefore?.dev !== targetAfter?.dev
    )
      throw new Error(`Working source path changed during publication: ${filename}`);
    if (expected === null) {
      // link(2) creates the first working file with an atomic no-replace
      // guarantee. An external creator wins, even between checks.
      try {
        await link(temporary, filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new Error(`Externally created working source during publication: ${filename}`);
        throw error;
      }
    } else {
      if (!exchange) throw new Error('Native atomic working-source exchange is unavailable.');
      // Atomic exchange retains the *actual* old target, including a competing
      // atomic-save rename in the gap after the final preflight hash check.
      exchangeAttempted = true;
      const backup = path.join(parent, `.working-${randomUUID()}.backup`);
      retainedOriginal = await exchange(temporary, filename, backup);
      if (
        !retainedOriginal ||
        path.dirname(retainedOriginal) !== parent ||
        !path.basename(retainedOriginal).startsWith('.working-')
      )
        throw new Error('Native exchange returned an unsafe retained-source path.');
      const displaced = await readSafe(retainedOriginal);
      if (!displaced || digest(displaced) !== expected) {
        // Roll back only if the editor-installed bytes still occupy the path.
        // Otherwise keep both versions, leaving the old manifest uncommitted.
        const installed = await readSafe(filename);
        if (installed?.equals(next)) {
          const rolledBack = await exchange(
            retainedOriginal,
            filename,
            path.join(parent, `.working-${randomUUID()}.backup`),
          );
          const abandoned = await readSafe(rolledBack);
          if (!abandoned?.equals(next))
            throw new Error(
              `Working source changed during rollback; competing bytes retained: ${rolledBack}`,
            );
          await rm(rolledBack, { force: true });
          retainedOriginal = null;
        }
        throw new Error(
          `Externally modified working source during atomic publication: ${filename}`,
        );
      }
      if (!(await readSafe(filename))?.equals(next))
        throw new Error(
          `Working source changed after atomic exchange; retained evidence: ${retainedOriginal}`,
        );
      await rm(retainedOriginal, { force: true });
      retainedOriginal = null;
    }
    await syncDirectory(path.dirname(filename));
  } finally {
    // On uncertain exchange failure, the old file may already have moved to
    // the stage name. Never delete it merely because the native call failed.
    if (!exchangeAttempted || retainedOriginal === null) await rm(temporary, { force: true });
  }
}

async function pruneSafe(root: string, filename: string, expected: string) {
  await ensureSafeDirectory(root, path.dirname(filename));
  const parentBefore = await statSafe(path.dirname(filename));
  const entryBefore = await statSafe(filename);
  const bytes = await readSafe(filename);
  if (!bytes || digest(bytes) !== expected)
    throw new Error(`Externally modified working source cannot be pruned: ${filename}`);
  const parentAfter = await statSafe(path.dirname(filename));
  const entryAfter = await statSafe(filename);
  if (
    !parentBefore ||
    !parentAfter ||
    parentBefore.dev !== parentAfter.dev ||
    parentBefore.ino !== parentAfter.ino ||
    entryBefore?.ino !== entryAfter?.ino ||
    entryBefore?.dev !== entryAfter?.dev
  )
    throw new Error(`Working source path changed before pruning: ${filename}`);
  // Move the *actual* entry to a quarantine name first. If an agent atomically
  // saved between the last comparison and rename, its bytes are retained and
  // the manifest is left stale rather than deleting its edit.
  const quarantine = path.join(path.dirname(filename), `.working-${randomUUID()}.pruned`);
  await rename(filename, quarantine);
  const displaced = await readSafe(quarantine);
  if (!displaced || digest(displaced) !== expected) {
    // Restore only when the original path is still absent; never replace an
    // agent file created while pruning.
    try {
      await link(quarantine, filename);
      await rm(quarantine, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    throw new Error(`Externally modified working source cannot be pruned: ${filename}`);
  }
  await rm(quarantine, { force: true });
  await syncDirectory(path.dirname(filename));
}

async function workingTreeRevisions(directory: string): Promise<Map<string, string>> {
  const root = await statSafe(directory);
  if (!root) return new Map();
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error('Unsafe Project working-source tree.');
  const result = new Map<string, string>();
  async function visit(dir: string) {
    for (const name of await readdir(dir)) {
      const filename = path.join(dir, name);
      const info = await statSafe(filename);
      if (!info || info.isSymbolicLink())
        throw new Error('Project working source changed or is linked.');
      if (info.isDirectory()) await visit(filename);
      else if (info.isFile()) {
        const bytes = await readSafe(filename);
        if (!bytes) throw new Error('Project working source disappeared during Copy.');
        result.set(path.relative(directory, filename), digest(bytes));
      } else throw new Error('Unsafe Project working-source file type.');
      if (result.size > 8192) throw new Error('Too many working-source files to copy.');
    }
  }
  await visit(directory);
  return result;
}

/** Clone the ignored working proposal alongside the separately copied recovery checkpoint.
 * Copy As must retain agent changes even when the editor has not imported them yet. */
export async function copyNativeWorkingSourceTree(
  sourceRoot: string,
  stagingRoot: string,
  targetRoot: string,
  projectId: string,
): Promise<void> {
  const from = path.join(await realpath(sourceRoot), WORKING_SOURCE_ROOT);
  const initial = await workingTreeRevisions(from);
  if (!initial.size) return;
  const manifestSource = await readSafe(path.join(from, 'manifest.json'));
  if (!manifestSource) throw new Error('Working sources lack publication identity.');
  const manifest = workingSourceManifestSchema.parse(JSON.parse(manifestSource.toString('utf8')));
  if (manifest.projectRoot !== (await realpath(sourceRoot)) || manifest.projectId !== projectId)
    throw new Error('Working-source Copy identity is stale or foreign.');
  const to = path.join(stagingRoot, WORKING_SOURCE_ROOT);
  await cp(from, to, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: async (filename) => {
      const item = await statSafe(filename);
      if (!item || item.isSymbolicLink() || (!item.isFile() && !item.isDirectory()))
        throw new Error('Project working source changed or is linked during Copy.');
      return true;
    },
  });
  const [sourceAfter, staged] = await Promise.all([
    workingTreeRevisions(from),
    workingTreeRevisions(to),
  ]);
  const entries = [...initial.entries()];
  if (
    sourceAfter.size !== initial.size ||
    staged.size !== initial.size ||
    entries.some(
      ([filename, hash]) => sourceAfter.get(filename) !== hash || staged.get(filename) !== hash,
    )
  )
    throw new Error('Working source changed during Project Copy.');
  const rebound = workingSourceManifestSchema.parse({
    ...manifest,
    projectRoot: targetRoot,
  });
  await writeFile(path.join(to, 'manifest.json'), JSON.stringify(rebound));
}

export class NativeWorkingSourcePublisher {
  private pending: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private requested: {
    root: string;
    projectId: string;
    snapshot: Snapshot;
    checkpoint: NativeDirtyCheckpoint;
  } | null = null;
  private failure: string | null = null;
  private readonly adopted = new Map<string, string>();
  private readonly adoptedPending = new Map<string, string>();

  constructor(
    private readonly idleMs = 200,
    private readonly sourceRevisionFor?: (bytes: Uint8Array) => string,
    private readonly exchange?: NativeFileExchange,
  ) {}

  schedule(root: string, projectId: string, snapshot: Snapshot, checkpoint: NativeDirtyCheckpoint) {
    // The native snapshots are immutable per publication; checkpoint is a new owned
    // value. Avoid cloning every dirty owner again on each keystroke.
    this.requested = { root, projectId, snapshot, checkpoint };
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      void this.flush().catch((error: unknown) => {
        console.error('Native working-source publication failed:', error);
      });
    }, this.idleMs);
  }

  get error() {
    return this.failure;
  }

  /** The native owner has acknowledged the exact agent bytes. The next
   * publication still CAS-checks those bytes; a subsequent edit is never lost. */
  adoptExternal(owner: string, observedRevision: string): void {
    this.adopted.set(owner, observedRevision);
  }

  adoptExternalPending(owner: string, observedRevision: string): void {
    this.adoptedPending.set(owner, observedRevision);
  }

  async flush(): Promise<void> {
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
    const requested = this.requested;
    if (!requested) {
      await this.inFlight;
      if (this.failure) throw new Error(this.failure);
      return;
    }
    this.requested = null;
    const current = this.inFlight.then(() => this.publish(requested));
    this.inFlight = current.catch(() => undefined);
    try {
      await current;
      this.failure = null;
      this.adopted.clear();
      this.adoptedPending.clear();
    } catch (error) {
      this.failure = String(error);
      throw error;
    }
  }

  /** Revoke any queued publication and return a barrier for a write that has
   * already begun. Callers closing or replacing a Project must await the
   * barrier before releasing its source worker or deleting its filesystem. */
  cancel(): Promise<void> {
    this.requested = null;
    this.adopted.clear();
    this.adoptedPending.clear();
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
    return this.inFlight;
  }

  private async publish(request: NonNullable<NativeWorkingSourcePublisher['requested']>) {
    const root = await realpath(request.root);
    const directory = path.join(root, WORKING_SOURCE_ROOT);
    // An absent tree is legitimate until the first dirty owner.
    const desired = nativeWorkingSourceProjection(request.snapshot, request.checkpoint);
    if (!desired.size && !(await statSafe(directory))) return;
    await ensureSafeDirectory(root, directory);
    const manifestPath = path.join(directory, 'manifest.json');
    const oldBytes = await readSafe(manifestPath);
    const old = oldBytes
      ? workingSourceManifestSchema.parse(JSON.parse(oldBytes.toString('utf8')))
      : null;
    if (old && (old.projectRoot !== root || old.projectId !== request.projectId))
      throw new Error('Working source belongs to a different Project identity.');
    // Check evidence for each owner about to change, not every dirty owner on
    // every keystroke. Import/recovery independently verifies all referenced
    // evidence before trusting it; untouched owners retain their old ledger.
    const verifyPreviousEvidence = async (previous: Entry | undefined) => {
      if (!previous) return;
      for (const revision of [previous.publishedRevision, previous.pendingRevision]) {
        if (!revision) continue;
        const baselinePath = path.join(directory, workingSourceBaselinePath(revision));
        await ensureSafeDirectory(root, path.dirname(baselinePath));
        const baseline = await readSafe(baselinePath);
        if (!baseline || digest(baseline) !== revision)
          throw new Error('Working-source publisher baseline is damaged or missing.');
      }
    };
    const entries: WorkingSourceManifest['entries'] = {};
    for (const [owner, item] of desired) {
      const locations = workingSourcePaths(owner);
      const previous = old?.entries[owner];
      if (
        previous &&
        item.representation !== 'pending-only' &&
        previous.representation === item.representation &&
        previous.checkpointRevision === item.checkpointRevision &&
        previous.diskRevision === item.diskRevision &&
        previous.pendingRevision === (item.pending ? digest(item.pending) : null) &&
        !this.adopted.has(owner) &&
        !this.adoptedPending.has(owner)
      ) {
        // No source, baseline or manifest read/write is needed for this owner.
        entries[owner] = previous;
        continue;
      }
      await verifyPreviousEvidence(previous);
      const main = item.representation === 'deleted' ? locations.deletion : locations.file;
      const mainPath = path.join(directory, main);
      const pendingPath = path.join(directory, locations.pending);
      const savedText = item.source
        ? await readProjectSource(root, owner, item.diskRevision, this.sourceRevisionFor)
        : undefined;
      const adoptedText = item.source && this.adopted.has(owner) ? await readSafe(mainPath) : null;
      if (adoptedText && digest(adoptedText) !== this.adopted.get(owner))
        throw new Error(`Agent edited accepted working source again: ${owner}`);
      const bytes = item.source
        ? Buffer.from(
            encodeStructuredYaml(
              item.source,
              adoptedText
                ? new TextDecoder('utf-8', { fatal: true }).decode(adoptedText)
                : savedText,
            ),
          )
        : item.bytes;
      let diskRevision = item.diskRevision;
      if (item.representation === 'pending-only') {
        const onDisk = await readProjectBytes(root, owner, true);
        if (onDisk && !this.sourceRevisionFor)
          throw new Error(`Native source hashing is unavailable for pending owner: ${owner}`);
        diskRevision = onDisk ? this.sourceRevisionFor!(onDisk) : 'absent';
      }
      const publishedRevision = bytes ? digest(bytes) : null;
      const pendingRevision = item.pending ? digest(item.pending) : null;
      if (bytes) {
        const baseline = path.join(directory, workingSourceBaselinePath(publishedRevision!));
        await ensureSafeDirectory(root, path.dirname(baseline));
        const existing = await readSafe(baseline);
        if (existing && !existing.equals(bytes))
          throw new Error('Working-source baseline was altered.');
        if (!existing) await atomicWrite(root, baseline, bytes, null, this.exchange);
        const expected =
          this.adopted.get(owner) ??
          (previous?.representation === item.representation ? previous.publishedRevision : null);
        await atomicWrite(root, mainPath, bytes, expected, this.exchange);
      }
      if (item.pending) {
        const baseline = path.join(directory, workingSourceBaselinePath(pendingRevision!));
        await ensureSafeDirectory(root, path.dirname(baseline));
        const existing = await readSafe(baseline);
        if (existing && !existing.equals(item.pending))
          throw new Error('Working-source pending baseline was altered.');
        if (!existing) await atomicWrite(root, baseline, item.pending, null, this.exchange);
        await atomicWrite(
          root,
          pendingPath,
          item.pending,
          this.adoptedPending.get(owner) ?? previous?.pendingRevision ?? null,
          this.exchange,
        );
      }
      if (previous && previous.representation !== item.representation && previous.publishedRevision)
        await pruneSafe(
          root,
          path.join(
            directory,
            previous.representation === 'deleted' ? locations.deletion : locations.file,
          ),
          this.adopted.get(owner) ?? previous.publishedRevision,
        );
      if (previous?.pendingRevision && !item.pending)
        await pruneSafe(
          root,
          pendingPath,
          this.adoptedPending.get(owner) ?? previous.pendingRevision,
        );
      entries[owner] = {
        representation: item.representation,
        publishedRevision: item.representation === 'pending-only' ? null : publishedRevision!,
        pendingRevision,
        diskRevision,
        checkpointRevision: item.checkpointRevision,
        localStateRevision: null,
      } as Entry;
    }
    for (const [owner, previous] of Object.entries(old?.entries ?? {})) {
      if (desired.has(owner)) continue;
      await verifyPreviousEvidence(previous);
      const locations = workingSourcePaths(owner);
      if (previous.publishedRevision)
        await pruneSafe(
          root,
          path.join(
            directory,
            previous.representation === 'deleted' ? locations.deletion : locations.file,
          ),
          this.adopted.get(owner) ?? previous.publishedRevision,
        );
      if (previous.pendingRevision)
        await pruneSafe(
          root,
          path.join(directory, locations.pending),
          this.adoptedPending.get(owner) ?? previous.pendingRevision,
        );
    }
    const next: WorkingSourceManifest = {
      schema: WORKING_SOURCE_SCHEMA,
      projectRoot: root,
      projectId: request.projectId,
      publication: (old?.publication ?? 0) + 1,
      entries,
    };
    workingSourceManifestSchema.parse(next);
    if (
      old &&
      Object.keys(old.entries).length === Object.keys(entries).length &&
      Object.entries(entries).every(
        ([owner, entry]) => JSON.stringify(old.entries[owner]) === JSON.stringify(entry),
      )
    )
      return;
    await atomicWrite(
      root,
      manifestPath,
      Buffer.from(JSON.stringify(next)),
      oldBytes ? digest(oldBytes) : null,
      this.exchange,
    );
  }
}
