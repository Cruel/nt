import type { JsonPatchOperation } from '../../renderer/project/json-patch';
import { diffJsonDocuments } from '../../renderer/project/project-external-reconciliation';
import type { JsonValue } from '../../renderer/project/json-value';
import type { NativeAuthoringCommand } from './native-authoring-worker-contract';
import type { NativeAuthoringSessionBridge } from './native-authoring-session-bridge';
import type { z } from 'zod';
import {
  nativeAuthoringResultSchema,
  nativeAuthoringSnapshotSchema,
} from './native-authoring-worker-contract';

type Snapshot = z.infer<typeof nativeAuthoringSnapshotSchema>;
type PatchResult = z.infer<typeof nativeAuthoringResultSchema>;
type NativePatch = Extract<NativeAuthoringCommand, { operation: 'patch' }>['patches'][number];
type Edit = Readonly<{ forward: NativePatch[]; inverse: NativePatch[] }>;
type RetainedBatch = Readonly<{
  patches: NativePatch[];
  diskPreconditions: Record<string, string>;
}>;

function nativePatches(patches: readonly JsonPatchOperation[]): NativePatch[] {
  return patches.map((patch) =>
    patch.op === 'remove'
      ? { operation: 'remove', path: patch.path }
      : { operation: patch.op, path: patch.path, value: patch.value },
  );
}

function sourceRevisions(snapshot: Snapshot, owners: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const owner of owners) {
    const revision =
      owner === 'project'
        ? snapshot.diskSourceRevision
        : snapshot.recordSnapshots?.[owner]?.diskSourceRevision;
    if (!revision) throw new Error(`Native working owner ${owner} lacks a disk baseline.`);
    result[owner] = revision;
  }
  return result;
}

function patchOwner(path: string): string {
  if (path.startsWith('/editor/')) return 'editor';
  const match = /^\/([^/]+)\/([^/]+)\//.exec(path);
  const recordFamilies = new Set([
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
  return match && recordFamilies.has(match[1]!) ? `${match[1]}/${match[2]}` : 'project';
}

/**
 * Certification-only mirror of existing editor command patches and undo/redo.
 * The production command bus remains authoritative until atomic Project cutover.
 * This is a main-owned replay journal; it does not persist invalid form input to YAML.
 */
export class NativeAuthoringWorkingProject {
  private view: Snapshot | null = null;
  private history: Edit[] = [];
  private cursor = 0;
  private retained: RetainedBatch[] = [];
  private readonly pendingFields = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private projectSessionId: string | null = null;

  constructor(private readonly bridge: NativeAuthoringSessionBridge) {}

  snapshot(): Snapshot | null {
    return this.view;
  }

  historyCursor(): number {
    return this.cursor;
  }

  pendingFieldText(path: string): string | undefined {
    return this.pendingFields.get(path);
  }

  setPendingFieldText(path: string, text: string | null): void {
    if (text === null) this.pendingFields.delete(path);
    else this.pendingFields.set(path, text);
  }

  async open(sessionId: string): Promise<Snapshot> {
    return this.serial(async () => {
      this.view = null;
      this.projectSessionId = null;
      this.history = [];
      this.cursor = 0;
      this.retained = [];
      this.pendingFields.clear();
      const opened = await this.bridge.open(sessionId);
      this.view = opened.snapshot;
      this.projectSessionId = sessionId;
      return opened.snapshot;
    });
  }

  // Load the initial working value of a visible record without producing a
  // content mutation or consuming an undo slot.
  async inspectRecord(owner: string): Promise<PatchResult> {
    return this.serial(async () => {
      const result = await this.bridge.request({ operation: 'inspect', owner });
      if (!result || !('accepted' in result))
        throw new Error('Native Project did not return a record snapshot.');
      if (result.accepted) {
        const merged = this.mergeSnapshot(result.snapshot);
        this.view = merged;
        return { ...result, snapshot: merged };
      }
      return result;
    });
  }

  /** Bring one verified external source into the dirty Project, without losing
   * local fields. Conflicts remain unresolved until Use Disk or Keep Mine. */
  async reconcile(owner: string): Promise<PatchResult> {
    return this.serial(async () => {
      const result = await this.bridge.request({ operation: 'reconcile', owner });
      if (!result || !('accepted' in result))
        throw new Error('Native Project did not return a reconciliation result.');
      if (result.accepted) {
        const merged = this.mergeSnapshot(result.snapshot);
        this.view = merged;
        this.checkpointDirtyWorkingState();
        return { ...result, snapshot: merged };
      }
      return result;
    });
  }

  /** Discard exactly one native Save owner's dirty edits and unresolved conflicts. */
  async useDisk(owner: string): Promise<PatchResult> {
    return this.serial(async () => {
      if (!this.view) throw new Error('Native working Project has not opened.');
      const result = await this.bridge.request({
        operation: 'useDisk',
        owner,
        expectedRevision: this.view.workingRevision,
      });
      if (!result || !('accepted' in result))
        throw new Error('Native Project did not return a Use Disk result.');
      if (result.accepted) {
        const kept = this.history
          .map((entry, index) => ({
            entry: {
              forward: entry.forward.filter((patch) => patchOwner(patch.path) !== owner),
              inverse: entry.inverse.filter((patch) => patchOwner(patch.path) !== owner),
            },
            index,
          }))
          .filter(({ entry }) => entry.forward.length && entry.inverse.length);
        this.cursor = kept.filter(({ index }) => index < this.cursor).length;
        this.history = kept.map(({ entry }) => entry);
        for (const path of this.pendingFields.keys())
          if (patchOwner(path) === owner) this.pendingFields.delete(path);
        const merged = this.mergeSnapshot(result.snapshot);
        this.view = merged;
        this.checkpointDirtyWorkingState();
        return { ...result, snapshot: merged };
      }
      return result;
    });
  }

  /** Scoped native Save: an exact-revision multi-owner YAML transaction. */
  async saveOwners(
    owners: readonly string[],
    options: { keepMine?: boolean; comments?: 'keep' | 'remove' | 'cancel' | 'perEdit' } = {},
  ): Promise<PatchResult> {
    return this.serial(async () => {
      if (!this.view) throw new Error('Native working Project has not opened.');
      const result = await this.bridge.request({
        operation: 'saveOwners',
        owners: [...owners],
        expectedRevision: this.view.workingRevision,
        keepMine: options.keepMine ?? false,
        comments: options.comments ?? 'keep',
      });
      if (!result || !('accepted' in result))
        throw new Error('Native Project did not return a scoped Save result.');
      if (result.accepted) {
        const merged = this.mergeSnapshot(result.snapshot);
        this.view = merged;
        this.checkpointDirtyWorkingState();
        return { ...result, snapshot: merged };
      }
      return result;
    });
  }

  // Existing editor CommandHandlerResult.patches and history.inversePatches are
  // passed verbatim as intent, not translated into per-action native commands.
  async applyAction(
    patches: readonly JsonPatchOperation[],
    inversePatches: readonly JsonPatchOperation[],
  ): Promise<PatchResult> {
    return this.serial(async () => {
      const forward = nativePatches(patches);
      const inverse = nativePatches(inversePatches);
      const result = await this.submit(forward);
      if (result.accepted && result.affectedRecords.length) {
        this.history = this.history.slice(0, this.cursor);
        this.history.push({ forward, inverse });
        ++this.cursor;
      }
      return result;
    });
  }

  async undo(): Promise<PatchResult> {
    return this.serial(async () => {
      if (!this.cursor) throw new Error('No native Project command to undo.');
      const result = await this.submit(this.history[this.cursor - 1]!.inverse);
      if (result.accepted) --this.cursor;
      return result;
    });
  }

  async redo(): Promise<PatchResult> {
    return this.serial(async () => {
      if (this.cursor >= this.history.length) throw new Error('No native Project command to redo.');
      const result = await this.submit(this.history[this.cursor]!.forward);
      if (result.accepted) ++this.cursor;
      return result;
    });
  }

  async reopenAndReplay(sessionId: string): Promise<Snapshot> {
    return this.serial(async () => {
      if (!this.projectSessionId || this.projectSessionId !== sessionId)
        throw new Error('Cannot replay native edits into a different Project session.');
      // Never replay an unacknowledged response: only retained accepted batches
      // have a known semantic effect. Every replayed owner is pinned to the
      // original exact source identity, not the worker's new revision zero.
      const batches = [...this.retained];
      const opened = await this.bridge.open(sessionId);
      this.view = opened.snapshot;
      try {
        for (const batch of batches) {
          const result = await this.requestPatch(batch.patches, batch.diskPreconditions);
          if (!result.accepted) throw new Error(`Native Project replay conflict: ${result.error}`);
          this.view = this.mergeSnapshot(result.snapshot);
        }
      } catch (error) {
        this.bridge.close();
        this.view = null;
        throw error;
      }
      return this.view;
    });
  }

  private async submit(patches: NativePatch[]): Promise<PatchResult> {
    const result = await this.requestPatch(patches);
    if (result.accepted && result.affectedRecords.length) {
      const merged = this.mergeSnapshot(result.snapshot);
      this.view = merged;
      this.retained.push({
        patches,
        diskPreconditions: sourceRevisions(merged, result.affectedRecords),
      });
      return { ...result, snapshot: merged };
    }
    return result;
  }

  private mergeSnapshot(incoming: Snapshot): Snapshot {
    return {
      ...incoming,
      recordSnapshots: {
        ...this.view?.recordSnapshots,
        ...incoming.recordSnapshots,
      },
    };
  }

  /** Recreate a minimal replayable journal from the current verified baselines.
   * This is necessary after reconciliation or Save advances source revisions. */
  private checkpointDirtyWorkingState(): void {
    if (!this.view) return;
    const batches: RetainedBatch[] = [];
    const owners: Array<[string, Snapshot | NonNullable<Snapshot['recordSnapshots']>[string]]> = [
      ['project', this.view],
      ...Object.entries(this.view.recordSnapshots ?? {}),
    ];
    for (const [owner, state] of owners) {
      if (!state.dirty) continue;
      if (state.baseline === undefined)
        throw new Error(`Native owner ${owner} has no saved baseline for recovery.`);
      const prefix = owner === 'project' ? '' : `/${owner}`;
      const patches = nativePatches(
        diffJsonDocuments(state.baseline as JsonValue, state.source as JsonValue).map((patch) => ({
          ...patch,
          path: prefix + patch.path,
        })),
      );
      if (patches.length)
        batches.push({
          patches,
          diskPreconditions: sourceRevisions(this.view, [owner]),
        });
    }
    this.retained = batches;
  }

  private async requestPatch(
    patches: NativePatch[],
    diskPreconditions?: Record<string, string>,
  ): Promise<PatchResult> {
    if (!this.view) throw new Error('Native working Project has not opened.');
    const result = await this.bridge.request({
      operation: 'patch',
      expectedRevision: this.view.workingRevision,
      patches,
      ...(diskPreconditions ? { diskPreconditions } : {}),
    });
    if (!result || !('accepted' in result))
      throw new Error('Native Project did not return a patch result.');
    if (result.accepted && result.snapshot.workingRevision < this.view.workingRevision)
      throw new Error('Native working Project revision went backwards.');
    return result;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
