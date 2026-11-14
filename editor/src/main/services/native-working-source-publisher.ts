import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
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
        checkpointRevision: digest(Buffer.from(JSON.stringify(batch))),
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

async function atomicWrite(root: string, filename: string, next: Buffer, expected: string | null) {
  if (next.byteLength > bytesLimit)
    throw new Error(`Working source exceeds size limit: ${filename}`);
  await ensureSafeDirectory(root, path.dirname(filename));
  const current = await readSafe(filename);
  if ((current ? digest(current) : null) !== expected)
    throw new Error(`Externally modified working source: ${filename}`);
  if (current && current.equals(next)) return;
  const temporary = path.join(path.dirname(filename), `.working-${randomUUID()}.tmp`);
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
    await rename(temporary, filename);
    await syncDirectory(path.dirname(filename));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function pruneSafe(filename: string, expected: string) {
  const bytes = await readSafe(filename);
  if (!bytes || digest(bytes) !== expected)
    throw new Error(`Externally modified working source cannot be pruned: ${filename}`);
  await unlink(filename);
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

  cancel() {
    this.requested = null;
    this.adopted.clear();
    this.adoptedPending.clear();
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
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
    // A manifest hash authorizes publication only while the original immutable
    // bytes are still available for later external three-way reconciliation.
    for (const previous of Object.values(old?.entries ?? {})) {
      for (const revision of [previous.publishedRevision, previous.pendingRevision]) {
        if (!revision) continue;
        const baseline = await readSafe(path.join(directory, workingSourceBaselinePath(revision)));
        if (!baseline || digest(baseline) !== revision)
          throw new Error('Working-source publisher baseline is damaged or missing.');
      }
    }
    const entries: WorkingSourceManifest['entries'] = {};
    for (const [owner, item] of desired) {
      const locations = workingSourcePaths(owner);
      const previous = old?.entries[owner];
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
        const existing = await readSafe(baseline);
        if (existing && !existing.equals(bytes))
          throw new Error('Working-source baseline was altered.');
        if (!existing) await atomicWrite(root, baseline, bytes, null);
        const expected =
          this.adopted.get(owner) ??
          (previous?.representation === item.representation ? previous.publishedRevision : null);
        await atomicWrite(root, mainPath, bytes, expected);
      }
      if (item.pending) {
        const baseline = path.join(directory, workingSourceBaselinePath(pendingRevision!));
        const existing = await readSafe(baseline);
        if (existing && !existing.equals(item.pending))
          throw new Error('Working-source pending baseline was altered.');
        if (!existing) await atomicWrite(root, baseline, item.pending, null);
        await atomicWrite(
          root,
          pendingPath,
          item.pending,
          this.adoptedPending.get(owner) ?? previous?.pendingRevision ?? null,
        );
      }
      if (previous && previous.representation !== item.representation && previous.publishedRevision)
        await pruneSafe(
          path.join(
            directory,
            previous.representation === 'deleted' ? locations.deletion : locations.file,
          ),
          this.adopted.get(owner) ?? previous.publishedRevision,
        );
      if (previous?.pendingRevision && !item.pending)
        await pruneSafe(pendingPath, this.adoptedPending.get(owner) ?? previous.pendingRevision);
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
      const locations = workingSourcePaths(owner);
      if (previous.publishedRevision)
        await pruneSafe(
          path.join(
            directory,
            previous.representation === 'deleted' ? locations.deletion : locations.file,
          ),
          this.adopted.get(owner) ?? previous.publishedRevision,
        );
      if (previous.pendingRevision)
        await pruneSafe(
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
    await atomicWrite(
      root,
      manifestPath,
      Buffer.from(JSON.stringify(next)),
      oldBytes ? digest(oldBytes) : null,
    );
  }
}
