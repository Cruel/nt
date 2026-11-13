import { constants } from 'node:fs';
import { link, mkdir, open, realpath, rename, rm, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { patchOwner, type NativeDirtyCheckpoint } from './native-authoring-working-project';

const revision = z.union([z.literal('absent'), z.string().regex(/^xxh3-128:[a-f0-9]{32}$/)]);
const patch = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('remove'), path: z.string().startsWith('/') }).strict(),
  z
    .object({
      operation: z.enum(['add', 'replace']),
      path: z.string().startsWith('/'),
      value: z.unknown(),
    })
    .strict(),
]);
const batchSchema = z
  .object({
    patches: z.array(patch).min(1).max(256),
    diskPreconditions: z.record(z.string().min(1), revision),
    layoutCopySources: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .superRefine((batch, context) => {
    if (!Object.keys(batch.diskPreconditions).length)
      context.addIssue({
        code: 'custom',
        message: 'Native recovery batch lacks physical source revisions.',
      });
    for (const operation of batch.patches) {
      const owner = patchOwner(operation.path);
      if (
        !(owner in batch.diskPreconditions) &&
        !(
          operation.path.startsWith('/localization/') &&
          Object.keys(batch.diskPreconditions).some((key) => key.startsWith('i18n/'))
        )
      )
        context.addIssue({
          code: 'custom',
          message: `Missing physical owner revision for ${operation.path}`,
        });
      if (operation.operation !== 'remove' && !Object.hasOwn(operation, 'value'))
        context.addIssue({
          code: 'custom',
          message: `Missing patch value for ${operation.path}`,
        });
    }
  });
const textSourceSchema = z
  .object({
    text: z.string().max(4 * 1024 * 1024),
    diskRevision: revision,
    admittedAtStage: z.literal(true).optional(),
    conflictBaseRevision: revision.optional(),
  })
  .strict();
const conflictSchema = z.array(z.string().startsWith('/'));
const pendingFieldSchema = z.string();
const ownerEvidenceSchema = z
  .object({
    diskRevision: revision,
    baseline: z.record(z.string(), z.unknown()),
    working: z.record(z.string(), z.unknown()),
  })
  .strict();
const checkpointSchema = z
  .object({
    batches: z.array(batchSchema).max(4096),
    ownerEvidence: z.record(z.string().min(1), ownerEvidenceSchema).optional(),
    textSources: z.record(z.string().min(1), textSourceSchema),
    conflicts: z.record(z.string().min(1), conflictSchema),
    pendingFields: z.record(z.string().startsWith('/'), pendingFieldSchema),
  })
  .strict();

const documentSchema = z
  .object({
    version: z.literal(1),
    projectRoot: z.string().min(1),
    projectId: z.string().min(1),
    checkpoint: checkpointSchema,
  })
  .strict();

const relativeFile = path.join('.noveltea', 'editor', 'native-dirty-state.json');
const maxCheckpointBytes = 24 * 1024 * 1024;
const emptyCheckpoint = (): NativeDirtyCheckpoint => ({
  batches: [],
  textSources: {},
  conflicts: {},
  pendingFields: {},
});

export interface NativeCheckpointReadResult {
  checkpoint: NativeDirtyCheckpoint | null;
  warning?: string;
}

/** A damaged batch invalidates its successors (later patches may depend on it).
 * Text buffers and pending fields are independent, but conflict markers require
 * a corresponding recovered physical owner. Never reconstruct missing values. */
function recoverIndependentEntries(
  document: unknown,
  canonicalRoot: string,
  projectId: string,
): NativeDirtyCheckpoint | null {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
  const value = document as Record<string, unknown>;
  if (value.version !== 1 || value.projectRoot !== canonicalRoot || value.projectId !== projectId)
    return null;
  if (!value.checkpoint || typeof value.checkpoint !== 'object' || Array.isArray(value.checkpoint))
    return null;
  const damaged = value.checkpoint as Record<string, unknown>;
  const result = emptyCheckpoint();
  if (Array.isArray(damaged.batches)) {
    for (const entry of damaged.batches.slice(0, 4096)) {
      const parsed = batchSchema.safeParse(entry);
      if (!parsed.success) break;
      result.batches.push(parsed.data);
    }
  }
  if (
    damaged.textSources &&
    typeof damaged.textSources === 'object' &&
    !Array.isArray(damaged.textSources)
  ) {
    for (const [name, entry] of Object.entries(damaged.textSources)) {
      if (!name) continue;
      const parsed = textSourceSchema.safeParse(entry);
      if (parsed.success) result.textSources[name] = parsed.data;
    }
  }
  const recoveredOwners = new Set(
    result.batches.flatMap((batch) => Object.keys(batch.diskPreconditions)),
  );
  if (
    damaged.ownerEvidence &&
    typeof damaged.ownerEvidence === 'object' &&
    !Array.isArray(damaged.ownerEvidence)
  ) {
    for (const [owner, entry] of Object.entries(damaged.ownerEvidence)) {
      if (!recoveredOwners.has(owner)) continue;
      const parsed = ownerEvidenceSchema.safeParse(entry);
      if (parsed.success) {
        result.ownerEvidence ??= {};
        result.ownerEvidence[owner] = parsed.data;
      }
    }
  }
  if (
    damaged.conflicts &&
    typeof damaged.conflicts === 'object' &&
    !Array.isArray(damaged.conflicts)
  ) {
    for (const [owner, entry] of Object.entries(damaged.conflicts)) {
      if (!recoveredOwners.has(owner)) continue;
      const parsed = conflictSchema.safeParse(entry);
      if (parsed.success) result.conflicts[owner] = parsed.data;
    }
  }
  if (
    damaged.pendingFields &&
    typeof damaged.pendingFields === 'object' &&
    !Array.isArray(damaged.pendingFields)
  ) {
    for (const [field, entry] of Object.entries(damaged.pendingFields)) {
      if (!field.startsWith('/')) continue;
      const parsed = pendingFieldSchema.safeParse(entry);
      if (parsed.success) result.pendingFields[field] = parsed.data;
    }
  }
  return result.batches.length ||
    Object.keys(result.textSources).length ||
    Object.keys(result.conflicts).length ||
    Object.keys(result.pendingFields).length
    ? result
    : null;
}

async function assertRecoveryDirectories(root: string, directory: string): Promise<boolean> {
  for (const component of [path.join(root, '.noveltea'), directory]) {
    let entry;
    try {
      entry = await lstat(component);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error(
        'Native Project recovery directory is unsafe (symbolic link or non-directory).',
      );
  }
  return true;
}

async function syncRecoveryDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Bound even a concurrently growing journal read. Do not allocate from a
 * stale stat size or stream an untrusted file into unbounded memory. */
async function readBoundedCheckpoint(file: Awaited<ReturnType<typeof open>>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let remaining = maxCheckpointBytes + 1;
  while (remaining > 0) {
    const block = Buffer.allocUnsafe(Math.min(remaining, 64 * 1024));
    const { bytesRead } = await file.read(block, 0, block.length, null);
    if (!bytesRead) break;
    chunks.push(block.subarray(0, bytesRead));
    remaining -= bytesRead;
  }
  return Buffer.concat(chunks);
}

/** Hard-link publication never replaces an archive. The original stays active
 * until its exact inode has been preserved; unsafe changes fail closed. */
async function quarantineCheckpoint(
  filename: string,
  directory: string,
  original: Awaited<ReturnType<typeof lstat>>,
): Promise<string> {
  if (!original.isFile() || original.isSymbolicLink())
    throw new Error('Native recovery journal is not a safe regular file.');
  const archive = `${filename}.quarantine-${randomUUID()}`;
  await link(filename, archive);
  const [active, archived] = await Promise.all([lstat(filename), lstat(archive)]);
  if (
    !active.isFile() ||
    active.isSymbolicLink() ||
    active.ino !== original.ino ||
    active.dev !== original.dev ||
    archived.ino !== original.ino ||
    archived.dev !== original.dev
  )
    throw new Error(
      `Native recovery journal changed during quarantine; preserved evidence at ${archive}.`,
    );
  await unlink(filename);
  await syncRecoveryDirectory(directory);
  return archive;
}

/** The native replay journal is local-only, independently of tracked Project YAML.
 * Publication is atomic and flushed before the native IPC acknowledgment. */
export class NativeDirtyCheckpointStore {
  async read(root: string, projectId: string): Promise<NativeDirtyCheckpoint | null> {
    return (await this.readResult(root, projectId)).checkpoint;
  }

  async readResult(root: string, projectId: string): Promise<NativeCheckpointReadResult> {
    const canonicalRoot = await realpath(root);
    const filename = path.join(canonicalRoot, relativeFile);
    const directory = path.dirname(filename);
    if (!(await assertRecoveryDirectories(canonicalRoot, directory))) return { checkpoint: null };
    let source;
    try {
      source = await lstat(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { checkpoint: null };
      throw error;
    }
    if (source.isSymbolicLink() || !source.isFile())
      throw new Error('Native recovery journal is a symbolic link or unsafe file type.');
    let decoded: unknown;
    let reason = 'incomplete or incompatible';
    if (source.size > maxCheckpointBytes) {
      reason = 'oversized';
    } else {
      const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let bytes: Buffer;
      try {
        const current = await file.stat();
        if (!current.isFile() || current.ino !== source.ino || current.dev !== source.dev)
          throw new Error('Native recovery journal changed during inspection.');
        bytes = await readBoundedCheckpoint(file);
      } finally {
        await file.close();
      }
      if (bytes.byteLength > maxCheckpointBytes) reason = 'oversized';
      else {
        try {
          // Invalid UTF-8 must never turn into replacement characters inside
          // recovered authored text. Treat those exact bytes as damaged evidence.
          decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          const parsed = documentSchema.safeParse(decoded);
          if (
            parsed.success &&
            parsed.data.projectRoot === canonicalRoot &&
            parsed.data.projectId === projectId
          )
            return { checkpoint: parsed.data.checkpoint as NativeDirtyCheckpoint };
          const identity = decoded as Partial<z.infer<typeof documentSchema>> | null;
          if (
            identity &&
            typeof identity === 'object' &&
            identity.version === 1 &&
            (identity.projectRoot !== canonicalRoot || identity.projectId !== projectId)
          )
            reason = 'from another Project identity';
          else if (identity && typeof identity === 'object' && identity.version !== 1)
            reason = 'unsupported';
        } catch {
          // No independent entry can be attributed from broken JSON syntax.
        }
      }
    }
    const salvaged =
      reason === 'incomplete or incompatible'
        ? recoverIndependentEntries(decoded, canonicalRoot, projectId)
        : null;
    const archive = await quarantineCheckpoint(filename, directory, source);
    await this.write(canonicalRoot, projectId, salvaged ?? emptyCheckpoint());
    return {
      checkpoint: salvaged,
      warning: salvaged
        ? `Recovery Checkpoint was ${reason}. Verified independent unsaved entries were retained for native replay; damaged entries remain in ${archive}.`
        : `Recovery Checkpoint was ${reason}. No unsaved work could be safely restored; the saved Project was opened and original recovery bytes are preserved at ${archive}.`,
    };
  }

  async write(
    root: string,
    projectId: string,
    checkpoint: NativeDirtyCheckpoint,
    identityRoot = root,
  ): Promise<void> {
    const canonicalRoot = await realpath(root);
    const filename = path.join(canonicalRoot, relativeFile);
    const directory = path.dirname(filename);
    if (!(await assertRecoveryDirectories(canonicalRoot, directory))) {
      await mkdir(path.join(canonicalRoot, '.noveltea')).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      if (!(await assertRecoveryDirectories(canonicalRoot, directory)))
        await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      await assertRecoveryDirectories(canonicalRoot, directory);
    }
    try {
      const active = await lstat(filename);
      if (active.isSymbolicLink() || !active.isFile())
        throw new Error('Native recovery journal is a symbolic link or unsafe file type.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const contents = JSON.stringify(
      documentSchema.parse({
        version: 1,
        // A staged Save Copy binds recovery to its final, already-selected destination.
        projectRoot: await realpath(identityRoot),
        projectId,
        checkpoint,
      }),
    );
    if (Buffer.byteLength(contents) > maxCheckpointBytes)
      throw new Error('Native Project recovery journal exceeds the maximum size.');
    const temporary = path.join(directory, `.native-dirty-${randomUUID()}.tmp`);
    try {
      const file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        await file.writeFile(contents, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, filename);
      // Directory sync is not supported on all editor hosts (notably Windows).
      await syncRecoveryDirectory(directory);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
