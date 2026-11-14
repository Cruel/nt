import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { decodeStructuredYaml } from '../../shared/project-workspace/structured-yaml-source';
import {
  WORKING_SOURCE_ROOT,
  workingSourceBaselinePath,
  workingSourceManifestSchema,
  workingSourcePendingSchema,
  workingSourcePaths,
} from '../../shared/project-workspace/working-source-contract';
import { diffJsonDocuments } from '../../renderer/project/project-external-reconciliation';
import type { JsonPatchOperation } from '../../renderer/project/json-patch';
import type { JsonValue } from '../../renderer/project/json-value';
import { jsonValuesEqual } from '../../renderer/project/json-value';
import type { NativeDirtyCheckpoint } from './native-authoring-working-project';
import type { nativeAuthoringSnapshotSchema } from './native-authoring-worker-contract';
import type { z } from 'zod';

type Snapshot = z.infer<typeof nativeAuthoringSnapshotSchema>;
const maxBytes = 4 * 1024 * 1024;
const sha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export type WorkingSourceImport = {
  owner: string;
  sourcePath: string;
  observed: string;
  patches: JsonPatchOperation[];
  conflicts: string[];
  text?: { value: string; diskRevision: string };
  pending?: Record<string, string | null>;
  pendingObserved?: string;
  sourceChanged: boolean;
};

export type WorkingSourceImportPlan = {
  changes: WorkingSourceImport[];
  warnings: { sourcePath: string; message: string }[];
  /** Never refresh the working projection while unadmitted evidence remains. */
  obstructed: boolean;
  /** Exact publication evidence, including unchanged artifacts, for a final CAS check. */
  observed: Map<string, string | null>;
};

function sourceOwner(sourcePath: string): string {
  if (sourcePath === 'project.yaml') return 'project';
  if (sourcePath === 'editor.yaml') return 'editor';
  if (sourcePath === 'traits.yaml') return 'traits';
  const record = /^records\/([^/]+)\/([^/]+)\.yaml$/.exec(sourcePath);
  if (record && record[1] !== 'layouts') return `${record[1]}/${record[2]}`;
  const layout = /^records\/layouts\/([^/]+)\/layout\.yaml$/.exec(sourcePath);
  if (layout) return `layouts/${layout[1]}`;
  return sourcePath;
}

function nativePath(owner: string, relative: string): string {
  const locale = /^i18n\/(locales|assets)\/([^/]+)\.yaml$/.exec(owner);
  const localization: Record<string, string> = {
    'i18n/project.yaml': '/localization',
    'i18n/messages.yaml': '/localization',
    'i18n/usage-notes.yaml': '/localization/usageNotes',
    'i18n/tracking.yaml': '/localization/sourceMessageTracking',
    'i18n/orphans.yaml': '/localization/orphanedMessages',
  };
  const prefix = locale
    ? `/localization/${locale[1] === 'locales' ? 'translations' : 'assets'}/${locale[2]}`
    : localization[owner]
      ? localization[owner]
      : owner === 'project'
        ? ''
        : `/${owner}`;
  return relative === '' ? prefix || '/' : `${prefix}${relative}`;
}

function overlap(a: string, b: string): boolean {
  return a === b || a === '' || b === '' || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function diffs(a: unknown, b: unknown): JsonPatchOperation[] {
  return diffJsonDocuments(a as JsonValue, b as JsonValue);
}

/** Read only under real Project root, rejecting every linked directory and file. */
async function readSource(root: string, relative: string): Promise<Buffer | null> {
  let at = root;
  const parts = relative.split('/');
  for (const segment of parts.slice(0, -1)) {
    at = path.join(at, segment);
    let stat;
    try {
      stat = await lstat(at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe working directory.');
  }
  const filename = path.join(at, parts[parts.length - 1]!);
  let stat;
  try {
    stat = await lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
    throw new Error('Unsafe or oversized working file.');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev)
      throw new Error('Working file changed during inspection.');
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) throw new Error('Working file exceeds size limit.');
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Used by admission and the final import fence; a missing file has an explicit revision. */
export async function workingSourceRevision(
  root: string,
  relative: string,
): Promise<string | null> {
  const bytes = await readSource(await realpath(root), `${WORKING_SOURCE_ROOT}/${relative}`);
  return bytes ? sha(bytes) : null;
}

/** A read-only admission plan: no working file or tracked source is ever written here. */
export async function planOfflineWorkingSourceImport(
  projectRoot: string,
  projectId: string,
  snapshot: Snapshot,
  checkpoint: NativeDirtyCheckpoint | null,
  sourceRevisionFor?: (bytes: Uint8Array) => string,
): Promise<WorkingSourceImportPlan> {
  // The common clean admission has no working manifest and requires no
  // filesystem proof from this optional projection. Only canonicalize once
  // there is actual working evidence to attribute to an admitted Project.
  let root = projectRoot;
  const plan: WorkingSourceImportPlan = {
    changes: [],
    warnings: [],
    obstructed: false,
    observed: new Map(),
  };
  const warn = (sourcePath: string, message: string) => {
    plan.warnings.push({ sourcePath, message });
    plan.obstructed = true;
  };
  let rawManifest: Buffer | null;
  try {
    rawManifest = await readSource(root, `${WORKING_SOURCE_ROOT}/manifest.json`);
  } catch (error) {
    warn('manifest.json', `Cannot inspect working-source manifest: ${String(error)}`);
    return plan;
  }
  if (!rawManifest) return plan;
  try {
    root = await realpath(projectRoot);
  } catch (error) {
    warn(
      'manifest.json',
      `Project root changed during working-source inspection: ${String(error)}`,
    );
    return plan;
  }
  let manifest: z.infer<typeof workingSourceManifestSchema>;
  try {
    manifest = workingSourceManifestSchema.parse(JSON.parse(rawManifest.toString('utf8')));
  } catch {
    warn('manifest.json', 'Working-source manifest is invalid; original files are preserved.');
    return plan;
  }
  if (manifest.projectRoot !== root || manifest.projectId !== projectId) {
    warn('manifest.json', 'Working-source manifest belongs to a different Project or path.');
    return plan;
  }
  if (!checkpoint) {
    if (Object.keys(manifest.entries).length)
      warn(
        'manifest.json',
        'No trusted native recovery checkpoint exists for these working files.',
      );
    return plan;
  }
  for (const [sourcePath, entry] of Object.entries(manifest.entries)) {
    const locations = workingSourcePaths(sourcePath);
    const main = entry.representation === 'deleted' ? locations.deletion : locations.file;
    const artifact = entry.representation === 'pending-only' ? locations.pending : main;
    try {
      if (entry.localStateRevision) {
        warn(
          sourcePath,
          'Working draft also depends on renderer-local evidence that cannot be verified offline.',
        );
        continue;
      }
      const [baseline, current, pending] = await Promise.all([
        entry.publishedRevision
          ? readSource(
              root,
              `${WORKING_SOURCE_ROOT}/${workingSourceBaselinePath(entry.publishedRevision)}`,
            )
          : Promise.resolve(null),
        readSource(root, `${WORKING_SOURCE_ROOT}/${artifact}`),
        entry.pendingRevision && entry.representation !== 'pending-only'
          ? readSource(root, `${WORKING_SOURCE_ROOT}/${locations.pending}`)
          : Promise.resolve(null),
      ]);
      if (entry.publishedRevision && (!baseline || sha(baseline) !== entry.publishedRevision)) {
        warn(sourcePath, 'Immutable working-source baseline is missing or damaged.');
        continue;
      }
      if (!current) {
        warn(
          sourcePath,
          'Working file was deleted or renamed; native and external evidence were retained.',
        );
        continue;
      }
      const oldPending = entry.pendingRevision
        ? await readSource(
            root,
            `${WORKING_SOURCE_ROOT}/${workingSourceBaselinePath(entry.pendingRevision)}`,
          )
        : null;
      if (entry.pendingRevision && (!oldPending || sha(oldPending) !== entry.pendingRevision)) {
        warn(sourcePath, 'Immutable pending-source baseline is missing or damaged.');
        continue;
      }
      // Detect an artifact moved between representation paths instead of silently choosing one.
      const other = entry.representation === 'deleted' ? locations.file : locations.deletion;
      if (await readSource(root, `${WORKING_SOURCE_ROOT}/${other}`)) {
        warn(sourcePath, 'Both source and deletion marker exist; resolution is required.');
        continue;
      }
      const observed = sha(current);
      plan.observed.set(artifact, observed);
      if (pending) plan.observed.set(locations.pending, sha(pending));
      const changed =
        observed !==
        (entry.representation === 'pending-only' ? entry.pendingRevision : entry.publishedRevision);
      const changedPending =
        entry.representation !== 'pending-only' &&
        (pending ? sha(pending) : null) !== entry.pendingRevision;
      if (!changed && !changedPending) continue;
      if (entry.representation === 'pending-only' || changedPending) {
        if (!sourceRevisionFor) {
          warn(
            sourcePath,
            'Native source revision verification is unavailable for the pending draft.',
          );
          continue;
        }
        const physical = await readSource(root, sourcePath);
        if ((physical ? sourceRevisionFor(physical) : 'absent') !== entry.diskRevision) {
          warn(
            sourcePath,
            'The saved owner changed since pending draft publication; explicit review is required.',
          );
          continue;
        }
      }
      const owner = sourceOwner(sourcePath);
      const result: WorkingSourceImport = {
        owner,
        sourcePath,
        observed,
        patches: [],
        conflicts: [],
        sourceChanged: changed && entry.representation === 'file',
      };
      if (entry.representation === 'deleted') {
        warn(sourcePath, 'Changed deletion marker requires explicit reconciliation.');
        continue;
      }
      if (entry.representation === 'pending-only' || changedPending) {
        const bytes = entry.representation === 'pending-only' ? current : pending;
        if (!bytes) {
          warn(sourcePath, 'Pending working draft was deleted.');
          continue;
        }
        const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
        const draft = workingSourcePendingSchema.parse(parsed);
        const before = workingSourcePendingSchema.parse(
          JSON.parse(oldPending!.toString('utf8')) as unknown,
        );
        if (Object.keys(draft.namedText).length) {
          warn(sourcePath, 'Named pending drafts require source-editor recovery.');
          continue;
        }
        if (
          Object.keys(before.namedText).length ||
          Object.entries(before.fieldText).some(
            ([key, value]) => checkpoint.pendingFields[key] !== value,
          ) ||
          Object.entries(draft.fieldText).some(
            ([key, value]) =>
              Object.hasOwn(checkpoint.pendingFields, key) &&
              !Object.hasOwn(before.fieldText, key) &&
              checkpoint.pendingFields[key] !== value,
          )
        ) {
          warn(sourcePath, 'Pending draft no longer matches native checkpoint evidence.');
          continue;
        }
        result.pending = Object.fromEntries(
          [...new Set([...Object.keys(before.fieldText), ...Object.keys(draft.fieldText)])].map(
            (key) => [key, draft.fieldText[key] ?? null],
          ),
        );
        result.pendingObserved = sha(bytes);
      }
      if (entry.representation === 'pending-only') {
        plan.changes.push(result);
        continue;
      }
      if (!changed) {
        plan.changes.push(result);
        continue;
      }
      const text = checkpoint.textSources[owner];
      if (text || !sourcePath.endsWith('.yaml')) {
        if (
          !text ||
          !baseline ||
          Buffer.from(text.text).compare(baseline) !== 0 ||
          !sourceRevisionFor
        ) {
          warn(sourcePath, 'Text working source does not match acknowledged checkpoint evidence.');
          continue;
        }
        const disk = await readSource(root, sourcePath);
        const diskRevision = disk ? sourceRevisionFor(disk) : 'absent';
        if (diskRevision !== entry.diskRevision || text.diskRevision !== entry.diskRevision) {
          warn(
            sourcePath,
            'Text source also changed on disk; both versions require conflict review.',
          );
          continue;
        }
        result.text = {
          value: new TextDecoder('utf-8', { fatal: true }).decode(current),
          diskRevision,
        };
        plan.changes.push(result);
        continue;
      }
      const evidence = checkpoint.ownerEvidence?.[owner];
      const native = owner === 'project' ? snapshot : snapshot.recordSnapshots?.[owner];
      if (!baseline || !evidence || !native || entry.diskRevision !== evidence.diskRevision) {
        warn(sourcePath, 'No matching acknowledged native owner baseline for this agent edit.');
        continue;
      }
      const previous = decodeStructuredYaml(baseline.toString('utf8'));
      const agent = decodeStructuredYaml(new TextDecoder('utf-8', { fatal: true }).decode(current));
      if (!mapping(previous) || !mapping(agent) || !mapping(evidence.working)) {
        warn(sourcePath, 'Working YAML has an invalid root or native checkpoint evidence.');
        continue;
      }
      if (!mapping(native.source) || !mapping(native.baseline)) {
        warn(sourcePath, 'Native owner has no recoverable source mapping.');
        continue;
      }
      const agentDiff = diffs(previous, agent);
      const nativeDiff = diffs(previous, native.source);
      const nativeEdits = nativeDiff.filter((edit) =>
        native.dirtyPatches.some((dirty) => overlap(edit.path, dirty.path)),
      );
      const diskDiff = diffs(evidence.baseline, native.baseline);
      for (const edit of agentDiff) {
        if (
          nativeEdits.some(
            (other) =>
              other.path === edit.path &&
              other.op === edit.op &&
              (edit.op === 'remove' ||
                (other.op !== 'remove' && jsonValuesEqual(other.value, edit.value))),
          )
        ) {
          // A previous cold admission may have durably checkpointed this
          // exact agent edit before the publisher could advance its manifest.
          // Do not replay it or misidentify the same value as a new conflict.
          continue;
        }
        if (nativeEdits.some((other) => overlap(edit.path, other.path))) {
          result.conflicts.push(edit.path || '/');
        } else {
          result.patches.push({ ...edit, path: nativePath(owner, edit.path) });
          if (diskDiff.some((other) => overlap(edit.path, other.path)))
            result.conflicts.push(edit.path || '/');
        }
      }
      if (!agentDiff.length) {
        // A comment/format-only change cannot be encoded into native structured mutations.
        warn(
          sourcePath,
          'Raw working YAML was changed without a semantic edit; source bytes are preserved.',
        );
        continue;
      }
      plan.changes.push(result);
      if (result.conflicts.length)
        warn(sourcePath, `Working-source overlap requires review: ${result.conflicts.join(', ')}`);
    } catch (error) {
      warn(sourcePath, `Cannot admit working source; external bytes retained: ${String(error)}`);
    }
  }
  return plan;
}
