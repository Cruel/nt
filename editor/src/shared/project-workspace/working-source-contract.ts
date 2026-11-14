import { z } from 'zod';

/** Same-build editor-local projection, not a Project Workspace format or recovery authority. */
export const WORKING_SOURCE_ROOT = '.noveltea/editor/working';
export const WORKING_SOURCE_SCHEMA = 'noveltea.editor.working-sources';

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const diskRevisionSchema = z.union([
  z.literal('absent'),
  z.string().regex(/^xxh3-128:[a-f0-9]{32}$/),
]);

const recordCollections = new Set([
  'animations',
  'archetypes',
  'assets',
  'characters',
  'dialogues',
  'interactables',
  'interactions',
  'layouts',
  'maps',
  'materials',
  'rooms',
  'scenes',
  'scripts',
  'tests',
  'variables',
  'verbs',
]);
const localizationOwners = new Set([
  'i18n/project.yaml',
  'i18n/messages.yaml',
  'i18n/usage-notes.yaml',
  'i18n/tracking.yaml',
  'i18n/orphans.yaml',
]);

/** Source identity is always a canonical Project-relative physical path, never a Save-unit ID. */
export function isWorkingSourceOwner(sourcePath: string): boolean {
  if (
    !sourcePath ||
    sourcePath.startsWith('/') ||
    sourcePath.includes('\\') ||
    sourcePath.includes('\0') ||
    sourcePath.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return false;
  if (['project.yaml', 'traits.yaml', 'editor.yaml'].includes(sourcePath)) return true;
  if (localizationOwners.has(sourcePath)) return true;
  if (/^i18n\/(locales|assets)\/[^/]+\.yaml$/.test(sourcePath)) return true;
  const record = /^records\/([^/]+)\/([^/]+)\.yaml$/.exec(sourcePath);
  if (record && record[1] !== 'layouts' && recordCollections.has(record[1]!)) return true;
  if (/^records\/layouts\/[^/]+\/layout\.yaml$/.test(sourcePath)) return true;
  if (/^records\/layouts\/[^/]+\/layout\.(rml|rcss|lua)$/.test(sourcePath)) return true;
  return /^scripts\/.+\.lua$/.test(sourcePath) || /^shaders\/.+[^/]$/.test(sourcePath);
}

/** Native snapshots key structured owners by domain ID; projections use physical paths. */
export function workingSourceForNativeOwner(nativeOwner: string): string | null {
  if (nativeOwner === 'project') return 'project.yaml';
  if (nativeOwner === 'traits') return 'traits.yaml';
  if (nativeOwner === 'editor') return 'editor.yaml';
  if (isWorkingSourceOwner(nativeOwner)) return nativeOwner;
  const record = /^([^/]+)\/([^/]+)$/.exec(nativeOwner);
  if (!record || !recordCollections.has(record[1]!)) return null;
  const path =
    record[1] === 'layouts'
      ? `records/layouts/${record[2]}/layout.yaml`
      : `records/${record[1]}/${record[2]}.yaml`;
  return isWorkingSourceOwner(path) ? path : null;
}

/** Files, deletion markers and pending drafts cannot collide, even for the same source owner. */
export function workingSourcePaths(sourcePath: string): {
  file: string;
  deletion: string;
  pending: string;
} {
  if (!isWorkingSourceOwner(sourcePath))
    throw new Error(`Not a supported working source: ${sourcePath}`);
  return {
    file: `files/${sourcePath}`,
    deletion: `deletions/${sourcePath}.delete.json`,
    pending: `pending/${sourcePath}.json`,
  };
}

/** The immutable baselines are comparison evidence, never recovered Project content. */
export function workingSourceBaselinePath(revision: string): string {
  const parsed = digestSchema.parse(revision);
  return `baselines/${parsed.slice('sha256:'.length)}.blob`;
}

/** A mismatch is never permission to replace a working file or its comparison baseline. */
export function inspectWorkingSourcePublication(
  publishedRevision: string,
  baselineRevision: string | null,
  observedRevision: string | null,
): 'untrusted-baseline' | 'changed' | 'unchanged' {
  digestSchema.parse(publishedRevision);
  if (baselineRevision !== publishedRevision) return 'untrusted-baseline';
  return observedRevision === publishedRevision ? 'unchanged' : 'changed';
}

export const workingSourcePendingSchema = z
  .object({
    fieldText: z.record(z.string().startsWith('/'), z.string()),
    namedText: z.record(z.string().min(1), z.string()),
  })
  .strict();

const commonWorkingEntry = {
  diskRevision: diskRevisionSchema,
  checkpointRevision: digestSchema,
  localStateRevision: digestSchema.nullable(),
};
const sourceWorkingEntry = {
  ...commonWorkingEntry,
  publishedRevision: digestSchema,
  pendingRevision: digestSchema.nullable(),
};

export const workingSourceEntrySchema = z.discriminatedUnion('representation', [
  z
    .object({
      representation: z.literal('file'),
      ...sourceWorkingEntry,
    })
    .strict(),
  z
    .object({
      representation: z.literal('deleted'),
      ...sourceWorkingEntry,
    })
    .strict(),
  z
    .object({
      representation: z.literal('pending-only'),
      ...commonWorkingEntry,
      publishedRevision: z.null(),
      pendingRevision: digestSchema,
    })
    .strict(),
]);

export const workingSourceManifestSchema = z
  .object({
    schema: z.literal(WORKING_SOURCE_SCHEMA),
    projectId: z.string().min(1),
    projectRoot: z.string().min(1),
    publication: z.number().int().nonnegative(),
    entries: z.record(z.string(), workingSourceEntrySchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    for (const owner of Object.keys(manifest.entries)) {
      if (!isWorkingSourceOwner(owner))
        context.addIssue({
          code: 'custom',
          path: ['entries', owner],
          message: 'Invalid physical source owner',
        });
    }
  });

export type WorkingSourceManifest = z.infer<typeof workingSourceManifestSchema>;
