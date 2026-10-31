import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, rm, lstat } from 'node:fs/promises';
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
const checkpointSchema = z
  .object({
    batches: z
      .array(
        z
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
          }),
      )
      .max(4096),
    textSources: z.record(
      z.string().min(1),
      z.object({ text: z.string().max(4 * 1024 * 1024), diskRevision: revision }).strict(),
    ),
    conflicts: z.record(z.string().min(1), z.array(z.string().startsWith('/'))),
    pendingFields: z.record(z.string().startsWith('/'), z.string()),
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

/** The native replay journal is local-only, independently of tracked Project YAML.
 * Publication is atomic and flushed before the native IPC acknowledgment. */
export class NativeDirtyCheckpointStore {
  async read(root: string, projectId: string): Promise<NativeDirtyCheckpoint | null> {
    const canonicalRoot = await realpath(root);
    const filename = path.join(canonicalRoot, relativeFile);
    const directory = path.dirname(filename);
    try {
      if (
        (await lstat(path.join(canonicalRoot, '.noveltea'))).isSymbolicLink() ||
        (await lstat(directory)).isSymbolicLink()
      )
        throw new Error('Native Project recovery path is a symbolic link.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let bytes: string;
    try {
      if ((await lstat(filename)).isSymbolicLink())
        throw new Error('Native recovery journal is a symbolic link.');
      bytes = await readFile(filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (Buffer.byteLength(bytes) > 24 * 1024 * 1024)
      throw new Error('Native Project recovery journal exceeds the maximum size.');
    let parsed: z.infer<typeof documentSchema>;
    try {
      parsed = documentSchema.parse(JSON.parse(bytes));
    } catch {
      throw new Error(
        'Native Project recovery journal is incomplete or incompatible; it was preserved for manual recovery.',
      );
    }
    if (parsed.projectRoot !== canonicalRoot || parsed.projectId !== projectId)
      throw new Error('Native recovery journal belongs to another Project identity.');
    return parsed.checkpoint as NativeDirtyCheckpoint;
  }

  async write(root: string, projectId: string, checkpoint: NativeDirtyCheckpoint): Promise<void> {
    const canonicalRoot = await realpath(root);
    const filename = path.join(canonicalRoot, relativeFile);
    const directory = path.dirname(filename);
    await mkdir(directory, { recursive: true });
    if (
      (await lstat(path.join(canonicalRoot, '.noveltea'))).isSymbolicLink() ||
      (await lstat(directory)).isSymbolicLink()
    )
      throw new Error('Native recovery directory is a symbolic link.');
    try {
      if ((await lstat(filename)).isSymbolicLink())
        throw new Error('Native recovery journal is a symbolic link.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const contents = JSON.stringify(
      documentSchema.parse({
        version: 1,
        projectRoot: canonicalRoot,
        projectId,
        checkpoint,
      }),
    );
    if (Buffer.byteLength(contents) > 24 * 1024 * 1024)
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
      if (process.platform !== 'win32') {
        const handle = await open(directory, constants.O_RDONLY);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
