import type { JsonPatchOperation } from '../../renderer/project/json-patch';
import { diffJsonDocuments } from '../../renderer/project/project-external-reconciliation';
import {
  PROJECT_SETTINGS_OWNED_PATHS,
  PROJECT_SETTINGS_SAVE_UNIT_ID,
} from '../../renderer/project/save-unit-registry';
import type { JsonValue } from '../../renderer/project/json-value';
import type { NativeAuthoringCommand } from './native-authoring-worker-contract';
import type { NativeAuthoringPreparation } from './native-authoring-worker-contract';
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
  layoutCopySources?: Record<string, string>;
}>;
type RetainedTextSource = Readonly<{ text: string; diskRevision: string }>;

/** A checkpoint contains only worker-acknowledged mutations. Renderer drafts and
 * pending invalid inputs remain in the existing local editor-state file. */
export interface NativeDirtyCheckpoint {
  batches: RetainedBatch[];
  textSources: Record<string, RetainedTextSource>;
  conflicts: Record<string, string[]>;
  pendingFields: Record<string, string>;
}

function nativePatches(patches: readonly JsonPatchOperation[]): NativePatch[] {
  return patches.map((patch) =>
    patch.op === 'remove'
      ? { operation: 'remove', path: patch.path }
      : { operation: patch.op, path: patch.path, value: patch.value },
  );
}

function logicalOwnerPath(owner: string): string {
  const locale = /^i18n\/(locales|assets)\/([^/]+)\.yaml$/.exec(owner);
  if (locale)
    return `/localization/${locale[1] === 'locales' ? 'translations' : 'assets'}/${locale[2]}`;
  const fixed: Record<string, string> = {
    'i18n/project.yaml': '/localization',
    'i18n/messages.yaml': '/localization',
    'i18n/usage-notes.yaml': '/localization/usageNotes',
    'i18n/tracking.yaml': '/localization/sourceMessageTracking',
    'i18n/orphans.yaml': '/localization/orphanedMessages',
  };
  return fixed[owner] ?? `/${owner}`;
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

export function patchOwner(path: string): string {
  if (path === '/editor') return 'editor';
  if (path === '/traits') return 'traits';
  if (path.startsWith('/editor/')) return 'editor';
  if (path.startsWith('/traits/')) return 'traits';
  const match = /^\/([^/]+)\/([^/]+)(?:\/|$)/.exec(path);
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

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function ownerPath(owner: string, relative: string): string {
  if (relative === '/') return owner === 'project' ? '/' : `/${owner}`;
  return owner === 'project' ? relative : `/${owner}${relative}`;
}

function logicalSaveUnitPaths(saveUnitId: string, snapshot: Snapshot): Record<string, string[]> {
  const match = /^record:([a-z]+):([a-z][a-z0-9-]*)$/.exec(saveUnitId);
  if (match) {
    const [, collection, id] = match;
    return {
      [`${collection}/${id}`]: ['/'],
      editor: [`/recordMetadata/${collection}/${id}`],
    };
  }
  const collection = /^collection:(assets|materials|tests|variables|traits)$/.exec(saveUnitId)?.[1];
  if (collection) {
    const owners = Object.keys(snapshot.recordSnapshots ?? {})
      .filter((owner) => owner.startsWith(`${collection}/`))
      .filter((owner) => snapshot.recordSnapshots?.[owner]?.dirty)
      .sort();
    return {
      ...Object.fromEntries(owners.map((owner) => [owner, ['/']])),
      ...(collection === 'traits' ? { traits: ['/'] } : {}),
      editor: [`/recordMetadata/${collection}`],
    };
  }
  if (saveUnitId === 'project:localization') {
    return Object.fromEntries(
      Object.keys(snapshot.recordSnapshots ?? {})
        .filter((owner) => owner.startsWith('i18n/'))
        .filter((owner) => snapshot.recordSnapshots?.[owner]?.dirty)
        .sort()
        .map((owner) => [owner, ['/']]),
    );
  }
  if (saveUnitId === 'project:platform-export-profiles')
    return { project: ['/export/runtime', '/export/profiles'] };
  if (saveUnitId === 'project:explorer-options') return { editor: ['/explorer'] };
  if (saveUnitId === 'project:chapters') return { editor: ['/chapters'] };
  if (saveUnitId === 'project:tags') return { editor: ['/tags'] };
  if (saveUnitId === 'editor:organization')
    return { editor: ['/chapters', '/tags', '/recordMetadata'] };
  if (saveUnitId === PROJECT_SETTINGS_SAVE_UNIT_ID)
    return { project: [...PROJECT_SETTINGS_OWNED_PATHS] };
  throw new Error(`Unsupported native logical Save unit: ${saveUnitId}`);
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
  private readonly retainedTextSources = new Map<string, RetainedTextSource>();
  private readonly pendingFields = new Map<string, string>();
  private readonly pendingDeletedOwners = new Map<string, string>();
  private readonly pendingLayoutCopySources = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private projectSessionId: string | null = null;

  constructor(private readonly bridge: NativeAuthoringSessionBridge) {}

  snapshot(): Snapshot | null {
    return this.view;
  }

  sessionId(): string | null {
    return this.projectSessionId;
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

  dirtyCheckpoint(): NativeDirtyCheckpoint {
    const conflicts: Record<string, string[]> = {};
    for (const [owner, source] of [
      ...Object.entries(this.view?.recordSnapshots ?? {}),
      ...(this.view ? [['project', this.view] as const] : []),
    ])
      if (source.conflictingPaths?.length) conflicts[owner] = [...source.conflictingPaths];
    return {
      batches: this.currentDirtyBatches().map((entry) => ({
        patches: structuredClone(entry.patches),
        diskPreconditions: { ...entry.diskPreconditions },
        ...(entry.layoutCopySources ? { layoutCopySources: { ...entry.layoutCopySources } } : {}),
      })),
      textSources: Object.fromEntries(this.retainedTextSources),
      conflicts,
      pendingFields: Object.fromEntries(this.pendingFields),
    };
  }

  hasDirtyCheckpoint(): boolean {
    const checkpoint = this.dirtyCheckpoint();
    return Boolean(
      checkpoint.batches.length ||
      Object.keys(checkpoint.textSources).length ||
      Object.keys(checkpoint.conflicts).length ||
      Object.keys(checkpoint.pendingFields).length,
    );
  }

  /** Only valid after opening the matching main-authorized Project. A failed
   * replay leaves the durable checkpoint untouched for explicit recovery. */
  async restoreDirtyCheckpoint(
    sessionId: string,
    checkpoint: NativeDirtyCheckpoint,
  ): Promise<Snapshot> {
    if (!this.projectSessionId || this.projectSessionId !== sessionId)
      throw new Error('Cannot restore native recovery into another Project session.');
    this.retained = structuredClone(checkpoint.batches);
    this.retainedTextSources.clear();
    for (const [path, source] of Object.entries(checkpoint.textSources))
      this.retainedTextSources.set(path, { ...source });
    this.pendingFields.clear();
    for (const [path, text] of Object.entries(checkpoint.pendingFields))
      this.pendingFields.set(path, text);
    // Undo/redo intent is renderer-local; restored edits form a new baseline
    // for subsequent session history, matching the existing reopen policy.
    this.history = [];
    this.cursor = 0;
    return this.replayDirtyCheckpoint(sessionId, checkpoint.conflicts);
  }

  async open(sessionId: string): Promise<Snapshot> {
    return this.serial(async () => {
      this.view = null;
      this.projectSessionId = null;
      this.history = [];
      this.cursor = 0;
      this.retained = [];
      this.retainedTextSources.clear();
      this.pendingDeletedOwners.clear();
      this.pendingLayoutCopySources.clear();
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
        const merged = this.mergeSnapshot(result.snapshot, result.affectedRecords);
        this.view = merged;
        return { ...result, snapshot: merged };
      }
      return result;
    });
  }

  /** Capture the native working generation for the certification-only
   * preview/Test adapter. Neither this method nor the worker saves files. */
  async prepareWorking(testId = ''): Promise<NativeAuthoringPreparation> {
    return this.serial(async () => {
      if (!this.view) throw new Error('Native working Project has not opened.');
      const result = await this.bridge.request({
        operation: 'prepareWorking',
        expectedRevision: this.view.workingRevision,
        testId,
      });
      if (!result || !('sourceRevisions' in result))
        throw new Error('Native Project did not return a preparation snapshot.');
      if (result.workingRevision !== this.view.workingRevision)
        throw new Error('Native Project preparation advanced past the active working generation.');
      return result;
    });
  }

  /** All effective native records, with verified source revisions, for editor
   * cutover certification. No saved TypeScript Project is used to fill gaps. */
  async prepareCompleteWorking(testId = ''): Promise<NativeAuthoringPreparation> {
    return this.serial(async () => {
      if (!this.view) throw new Error('Native working Project has not opened.');
      const expectedRevision = this.view.workingRevision;
      const result = await this.bridge.request({
        operation: 'prepareCompleteWorking',
        expectedRevision,
        testId,
      });
      if (result.workingRevision !== expectedRevision)
        throw new Error('Native complete Project preparation advanced the working generation.');
      if (result.accepted && !result.completeProject)
        throw new Error('Native complete Project omitted its effective records.');
      return result;
    });
  }

  async stageTextSource(
    path: string,
    text: string,
    diskPrecondition?: string,
  ): Promise<PatchResult> {
    return this.serial(async () => {
      if (!this.view) throw new Error('Native working Project has not opened.');
      const result = await this.bridge.request({
        operation: 'stageTextSource',
        expectedRevision: this.view.workingRevision,
        path,
        text,
        ...(diskPrecondition ? { diskPrecondition } : {}),
      });
      if (!result || !('accepted' in result))
        throw new Error('Native Project did not return a text-source result.');
      if (result.accepted) {
        if (result.textSourceStaged === undefined || !result.textSourceDiskRevision)
          throw new Error('Native text source omitted its acknowledged recovery evidence.');
        this.view = this.mergeSnapshot(result.snapshot);
        if (result.textSourceStaged)
          this.retainedTextSources.set(path, { text, diskRevision: result.textSourceDiskRevision });
        else this.retainedTextSources.delete(path);
      }
      return result;
    });
  }

  async saveTextSources(expectedRevision: number, paths: readonly string[]): Promise<PatchResult> {
    return this.serial(async () => {
      if (!this.view || this.view.workingRevision !== expectedRevision)
        throw new Error('Stale native Project text Save revision.');
      const result = await this.bridge.request({
        operation: 'saveTextSources',
        expectedRevision,
        paths: [...paths],
        diskPreconditions: Object.fromEntries(
          paths.flatMap((path) => {
            const retained = this.retainedTextSources.get(path);
            return retained ? [[path, retained.diskRevision]] : [];
          }),
        ),
      });
      if (!result || !('accepted' in result))
        throw new Error('Native Project did not acknowledge the physical text Save.');
      if (result.accepted) {
        if (!result.textSourceDiskRevisions)
          throw new Error('Native text Save omitted its physical source revision evidence.');
        for (const path of paths) {
          if (!result.textSourceDiskRevisions[path])
            throw new Error('Native text Save omitted source revision for ' + path);
          this.retainedTextSources.delete(path);
        }
        this.view = this.mergeSnapshot(result.snapshot);
        this.checkpointDirtyWorkingState();
        return { ...result, snapshot: this.view };
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
        const prior = this.view;
        const merged = this.mergeSnapshot(result.snapshot, result.affectedRecords);
        this.view = merged;
        const previous = owner === 'project' ? prior : prior?.recordSnapshots?.[owner];
        const current = owner === 'project' ? merged : merged.recordSnapshots?.[owner];
        if (previous?.baseline !== undefined && current?.baseline !== undefined) {
          const changed = diffJsonDocuments(
            previous.baseline as JsonValue,
            current.baseline as JsonValue,
          ).map((patch) => ownerPath(owner, patch.path));
          if (changed.length) this.invalidateHistoryPaths(changed);
        }
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

  async mutateSourceDirectory(
    expectedRevision: number,
    kind: 'create' | 'move' | 'delete',
    from: string,
    to = '',
  ): Promise<PatchResult> {
    return this.serial(async () => {
      if (!this.view || this.view.workingRevision !== expectedRevision)
        throw new Error('Stale native source directory revision.');
      const result = await this.bridge.request({
        operation: 'mutateSourceDirectory',
        expectedRevision,
        kind,
        from,
        to,
      });
      if (!result || !('accepted' in result))
        throw new Error('Native source directory response is invalid.');
      if (result.accepted) {
        this.view = this.mergeSnapshot(result.snapshot, result.affectedRecords);
        this.checkpointDirtyWorkingState();
        return { ...result, snapshot: this.view };
      }
      return result;
    });
  }

  /** Scoped native Save: an exact-revision multi-owner YAML transaction. */
  async saveOwners(
    owners: readonly string[],
    options: {
      keepMine?: boolean;
      comments?: 'keep' | 'remove' | 'cancel' | 'perEdit';
      pathsByOwner?: Record<string, string[]>;
      textPaths?: string[];
      textContents?: Record<string, string>;
      expectedRevision?: number;
      assetTransition?: import('./native-authoring-worker-contract').NativeAssetTransition;
    } = {},
  ): Promise<PatchResult> {
    for (const owner of owners)
      if (
        owner !== 'project' &&
        !this.pendingDeletedOwners.has(owner) &&
        !this.view?.recordSnapshots?.[owner]
      ) {
        const inspected = await this.inspectRecord(owner);
        if (!inspected.accepted)
          throw new Error(
            `Native structural Save owner ${owner} is unavailable: ${inspected.error}`,
          );
      }
    return this.serial(async () => {
      if (!this.view) throw new Error('Native working Project has not opened.');
      if (
        options.expectedRevision !== undefined &&
        options.expectedRevision !== this.view.workingRevision
      )
        throw new Error('Stale native working Project Save revision.');
      if (options.textPaths?.length) {
        for (const path of options.textPaths)
          if (
            !this.retainedTextSources.has(path) ||
            this.retainedTextSources.get(path)!.text !== options.textContents?.[path]
          )
            throw new Error(`Native staged source changed before mixed Save: ${path}`);
      }
      const result = await this.bridge.request({
        operation: 'saveOwners',
        owners: [...owners],
        expectedRevision: this.view.workingRevision,
        keepMine: options.keepMine ?? false,
        comments: options.comments ?? 'keep',
        ...(options.pathsByOwner ? { pathsByOwner: options.pathsByOwner } : {}),
        ...(options.textPaths ? { textPaths: options.textPaths } : {}),
        ...(options.assetTransition ? { assetTransition: options.assetTransition } : {}),
      });
      if (!result || !('accepted' in result))
        throw new Error('Native Project did not return a scoped Save result.');
      if (result.accepted) {
        const merged = this.mergeSnapshot(result.snapshot, result.affectedRecords);
        this.view = merged;
        for (const owner of result.affectedRecords) {
          this.pendingDeletedOwners.delete(owner);
          this.pendingLayoutCopySources.delete(owner);
        }
        if (options.textPaths?.length) {
          for (const path of options.textPaths) {
            if (!result.textSourceDiskRevisions?.[path])
              throw new Error(`Native mixed Save omitted text source acknowledgment: ${path}`);
            this.retainedTextSources.delete(path);
          }
        }
        this.checkpointDirtyWorkingState();
        return { ...result, snapshot: merged };
      }
      return result;
    });
  }

  async saveUnits(
    saveUnitIds: readonly string[],
    options: {
      keepMine?: boolean;
      comments?: 'keep' | 'remove' | 'cancel' | 'perEdit';
      textPaths?: string[];
      textContents?: Record<string, string>;
    } = {},
    expectedRevision?: number,
  ): Promise<PatchResult> {
    if (!this.view) throw new Error('Native working Project has not opened.');
    const pathsByOwner: Record<string, string[]> = {};
    for (const saveUnitId of [...new Set(saveUnitIds)].sort()) {
      const scopes = logicalSaveUnitPaths(saveUnitId, this.view);
      for (const [owner, paths] of Object.entries(scopes))
        pathsByOwner[owner] = [...new Set([...(pathsByOwner[owner] ?? []), ...paths])].sort();
    }
    if (saveUnitIds.includes('project:localization'))
      for (const owner of this.pendingDeletedOwners.keys())
        if (owner.startsWith('i18n/')) pathsByOwner[owner] = ['/'];
    for (const owner of Object.keys(pathsByOwner))
      if (
        owner !== 'project' &&
        !this.pendingDeletedOwners.has(owner) &&
        !this.view?.recordSnapshots?.[owner]
      ) {
        const inspected = await this.inspectRecord(owner);
        if (!inspected.accepted)
          throw new Error(`Native Save unit owner ${owner} is unavailable: ${inspected.error}`);
      }
    return this.saveOwners(Object.keys(pathsByOwner).sort(), {
      ...options,
      pathsByOwner,
      expectedRevision,
    });
  }

  async saveUnit(
    saveUnitId: string,
    options: { keepMine?: boolean; comments?: 'keep' | 'remove' | 'cancel' | 'perEdit' } = {},
    expectedRevision?: number,
  ): Promise<PatchResult> {
    return this.saveUnits([saveUnitId], options, expectedRevision);
  }

  async useDiskUnit(saveUnitId: string): Promise<PatchResult> {
    if (!this.view) throw new Error('Native working Project has not opened.');
    const pathsByOwner = logicalSaveUnitPaths(saveUnitId, this.view);
    if (saveUnitId === 'project:localization')
      for (const owner of this.pendingDeletedOwners.keys())
        if (owner.startsWith('i18n/')) pathsByOwner[owner] = ['/'];
    for (const owner of Object.keys(pathsByOwner))
      if (
        owner !== 'project' &&
        !this.pendingDeletedOwners.has(owner) &&
        !this.view?.recordSnapshots?.[owner]
      ) {
        const inspected = await this.inspectRecord(owner);
        if (!inspected.accepted)
          throw new Error(`Native Use Disk unit owner ${owner} is unavailable: ${inspected.error}`);
      }
    return this.serial(async () => {
      if (!this.view) throw new Error('Native working Project has not opened.');
      const result = await this.bridge.request({
        operation: 'useDiskOwners',
        expectedRevision: this.view.workingRevision,
        pathsByOwner,
      });
      if (!result || !('accepted' in result))
        throw new Error('Native Project did not return a logical Use Disk result.');
      if (result.accepted) {
        this.view = this.mergeSnapshot(result.snapshot, result.affectedRecords);
        for (const owner of result.affectedRecords) this.pendingDeletedOwners.delete(owner);
        const paths = Object.entries(pathsByOwner).flatMap(([owner, fields]) =>
          fields.map((field) => ownerPath(owner, field)),
        );
        this.invalidateHistoryPaths(paths);
        for (const path of this.pendingFields.keys())
          if (paths.some((selected) => overlaps(path, selected))) this.pendingFields.delete(path);
        this.checkpointDirtyWorkingState();
        return { ...result, snapshot: this.view };
      }
      return result;
    });
  }

  // Existing editor CommandHandlerResult.patches and history.inversePatches are
  // passed verbatim as intent, not translated into per-action native commands.
  /** The production IPC command seam supplies its own undo/redo intent and
   * authoritative expected revision. Unlike applyAction this does not keep
   * a second main-side command-history cursor: the editor's history remains
   * UI intent, while only the native worker can admit an actual mutation. */
  async applyRevisionedPatches(
    expectedRevision: number,
    patches: readonly JsonPatchOperation[],
    layoutCopySources?: Record<string, string>,
  ): Promise<PatchResult> {
    return this.serial(async () => {
      if (!this.view || this.view.workingRevision !== expectedRevision)
        throw new Error('Stale native Project mutation revision.');
      for (const patch of patches) {
        if (patch.op !== 'remove') continue;
        const localized = /^\/localization\/(translations|assets)\/([^/]+)$/.exec(patch.path);
        if (!localized && !/^\/[a-z]+\/[a-z][a-z0-9-]*$/.test(patch.path)) continue;
        const owner = localized
          ? `i18n/${localized[1] === 'translations' ? 'locales' : 'assets'}/${localized[2]}.yaml`
          : patch.path.slice(1);
        if (this.view.recordSnapshots?.[owner] || this.pendingDeletedOwners.has(owner)) continue;
        const inspected = await this.bridge.request({ operation: 'inspect', owner });
        if (!inspected || !('accepted' in inspected) || !inspected.accepted)
          throw new Error(
            `Cannot inspect native structural removal ${owner}: ${inspected && 'error' in inspected ? inspected.error : 'no response'}`,
          );
        this.view = this.mergeSnapshot(inspected.snapshot);
      }
      return this.submit(nativePatches(patches), layoutCopySources);
    });
  }

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
    return this.replayDirtyCheckpoint(sessionId, this.dirtyCheckpoint().conflicts);
  }

  private async replayDirtyCheckpoint(
    sessionId: string,
    conflicts: Record<string, string[]>,
  ): Promise<Snapshot> {
    return this.serial(async () => {
      if (!this.projectSessionId || this.projectSessionId !== sessionId)
        throw new Error('Cannot replay native edits into a different Project session.');
      // Never replay an unacknowledged response: only retained accepted batches
      // have a known semantic effect. Every replayed owner is pinned to the
      // original exact source identity, not the worker's new revision zero.
      const batches = [...this.retained];
      const textSources = [...this.retainedTextSources];
      const opened = await this.bridge.open(sessionId);
      this.view = opened.snapshot;
      this.pendingDeletedOwners.clear();
      this.pendingLayoutCopySources.clear();
      try {
        for (const batch of batches) {
          const result = await this.requestPatch(
            batch.patches,
            batch.diskPreconditions,
            batch.layoutCopySources,
          );
          if (!result.accepted) throw new Error(`Native Project replay conflict: ${result.error}`);
          this.view = this.mergeSnapshot(result.snapshot, result.affectedRecords);
          for (const patch of batch.patches) {
            if (patch.operation === 'add' && /^\/layouts\/[a-z][a-z0-9-]*$/.test(patch.path)) {
              const owner = patch.path.slice(1);
              if (batch.layoutCopySources?.[owner])
                this.pendingLayoutCopySources.set(owner, batch.layoutCopySources[owner]);
            }
            if (patch.operation === 'remove' && /^\/layouts\/[a-z][a-z0-9-]*$/.test(patch.path))
              this.pendingLayoutCopySources.delete(patch.path.slice(1));
            if (
              patch.operation !== 'remove' ||
              (!/^\/[a-z]+\/[a-z][a-z0-9-]*$/.test(patch.path) &&
                !/^\/localization\/(translations|assets)\/[^/]+$/.test(patch.path))
            )
              continue;
            const localized = /^\/localization\/(translations|assets)\/([^/]+)$/.exec(patch.path);
            const owner = localized
              ? `i18n/${localized[1] === 'translations' ? 'locales' : 'assets'}/${localized[2]}.yaml`
              : patch.path.slice(1);
            if (
              !this.view.recordSnapshots?.[owner] &&
              batch.diskPreconditions[owner] &&
              batch.diskPreconditions[owner] !== 'absent'
            )
              this.pendingDeletedOwners.set(owner, batch.diskPreconditions[owner]);
          }
        }
        for (const [path, retained] of textSources) {
          const restored = await this.bridge.request({
            operation: 'stageTextSource',
            expectedRevision: this.view.workingRevision,
            path,
            text: retained.text,
            diskPrecondition: retained.diskRevision,
          });
          if (!restored || !('accepted' in restored) || !restored.accepted)
            throw new Error(
              `Native Project text-source replay failed for ${path}: ${restored && 'error' in restored ? restored.error : 'invalid response'}`,
            );
          if (
            restored.textSourceStaged !== true ||
            restored.textSourceDiskRevision !== retained.diskRevision
          )
            throw new Error(`Native Project text-source recovery conflict for ${path}`);
          this.view = this.mergeSnapshot(restored.snapshot);
        }
        if (Object.keys(conflicts).length) {
          const restored = await this.bridge.request({
            operation: 'restoreConflicts',
            expectedRevision: this.view.workingRevision,
            conflicts,
          });
          if (!restored || !('accepted' in restored) || !restored.accepted)
            throw new Error(
              `Native Project conflict recovery failed: ${restored && 'error' in restored ? restored.error : 'invalid response'}`,
            );
          this.view = this.mergeSnapshot(restored.snapshot);
        }
      } catch (error) {
        this.bridge.close();
        this.view = null;
        throw error;
      }
      return this.view;
    });
  }

  private async submit(
    patches: NativePatch[],
    layoutCopySources?: Record<string, string>,
  ): Promise<PatchResult> {
    const before = this.view;
    const result = await this.requestPatch(patches, undefined, layoutCopySources);
    if (result.accepted && result.affectedRecords.length) {
      const merged = this.mergeSnapshot(result.snapshot, result.affectedRecords);
      this.view = merged;
      for (const patch of patches) {
        const localized = /^\/localization\/(translations|assets)\/([^/]+)$/.exec(patch.path);
        if (!localized && !/^\/[a-z]+\/[a-z][a-z0-9-]*$/.test(patch.path)) continue;
        const owner = localized
          ? `i18n/${localized[1] === 'translations' ? 'locales' : 'assets'}/${localized[2]}.yaml`
          : patch.path.slice(1);
        if (patch.operation === 'add' && merged.recordSnapshots?.[owner])
          this.pendingDeletedOwners.delete(owner);
        if (patch.operation === 'add' && layoutCopySources?.[owner])
          this.pendingLayoutCopySources.set(owner, layoutCopySources[owner]);
        if (patch.operation === 'remove') this.pendingLayoutCopySources.delete(owner);
        if (patch.operation === 'remove' && !merged.recordSnapshots?.[owner]) {
          const revision = before?.recordSnapshots?.[owner]?.diskSourceRevision;
          if (revision && revision !== 'absent') this.pendingDeletedOwners.set(owner, revision);
          else this.pendingDeletedOwners.delete(owner);
        }
      }
      if (
        result.affectedRecords.some(
          (owner) => owner !== 'project' && !merged.recordSnapshots?.[owner],
        )
      ) {
        this.checkpointDirtyWorkingState();
      } else {
        this.retained.push({
          patches,
          diskPreconditions: sourceRevisions(merged, result.affectedRecords),
          ...(layoutCopySources ? { layoutCopySources } : {}),
        });
      }
      return { ...result, snapshot: merged };
    }
    return result;
  }

  private mergeSnapshot(incoming: Snapshot, affectedRecords: readonly string[] = []): Snapshot {
    const records = { ...this.view?.recordSnapshots, ...incoming.recordSnapshots };
    for (const owner of affectedRecords)
      if (owner !== 'project' && !incoming.recordSnapshots?.[owner]) delete records[owner];
    return {
      ...incoming,
      recordSnapshots: records,
    };
  }

  private invalidateHistoryPaths(changedPaths: readonly string[]): void {
    const kept = this.history
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry }) =>
          ![...entry.forward, ...entry.inverse].some((patch) =>
            changedPaths.some((changed) => overlaps(patch.path, changed)),
          ),
      );
    this.cursor = kept.filter(({ index }) => index < this.cursor).length;
    this.history = kept.map(({ entry }) => entry);
  }

  /** Recreate a minimal replayable journal from the current verified baselines.
   * This is necessary after reconciliation or Save advances source revisions. */
  private checkpointDirtyWorkingState(): void {
    this.retained = this.currentDirtyBatches();
  }

  private currentDirtyBatches(): RetainedBatch[] {
    if (!this.view) return [];
    const batches: RetainedBatch[] = [];
    const owners: Array<[string, Snapshot | NonNullable<Snapshot['recordSnapshots']>[string]]> = [
      ['project', this.view],
      ...Object.entries(this.view.recordSnapshots ?? {}),
    ];
    for (const [owner, state] of owners) {
      if (!state.dirty) continue;
      if (state.baseline === undefined)
        throw new Error(`Native owner ${owner} has no saved baseline for recovery.`);
      const prefix = owner === 'project' ? '' : logicalOwnerPath(owner);
      const patches =
        state.diskSourceRevision === 'absent' && owner !== 'project'
          ? [{ operation: 'add' as const, path: prefix, value: state.source }]
          : nativePatches(
              diffJsonDocuments(state.baseline as JsonValue, state.source as JsonValue).map(
                (patch) => ({
                  ...patch,
                  path: prefix + patch.path,
                }),
              ),
            );
      if (patches.length)
        batches.push({
          patches,
          diskPreconditions: sourceRevisions(this.view, [owner]),
          ...(this.pendingLayoutCopySources.has(owner)
            ? {
                layoutCopySources: { [owner]: this.pendingLayoutCopySources.get(owner)! },
              }
            : {}),
        });
    }
    for (const [owner, revision] of this.pendingDeletedOwners)
      batches.push({
        patches: [{ operation: 'remove', path: logicalOwnerPath(owner) }],
        diskPreconditions: { [owner]: revision },
      });
    return batches;
  }

  private async requestPatch(
    patches: NativePatch[],
    diskPreconditions?: Record<string, string>,
    layoutCopySources?: Record<string, string>,
  ): Promise<PatchResult> {
    if (!this.view) throw new Error('Native working Project has not opened.');
    const result = await this.bridge.request({
      operation: 'patch',
      expectedRevision: this.view.workingRevision,
      patches,
      ...(diskPreconditions ? { diskPreconditions } : {}),
      ...(layoutCopySources ? { layoutCopySources } : {}),
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
