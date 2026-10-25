import {
  currentAuthoringGraphSnapshot,
  isAuthoringDependencyGraphServiceStarted,
} from '@/project/authoring-dependency-graph-runtime';
import { applyJsonPatch, type JsonPatchOperation } from '@/project/json-patch';
import {
  buildJsonPointer,
  getJsonAtPointer,
  hasJsonAtPointer,
  parseJsonPointer,
} from '@/project/json-pointer';
import type { JsonValue } from '@/project/json-value';
import { jsonValuesEqual } from '@/project/json-value';
import { confirmProjectComments } from '@/project/project-comment-confirmation';
import { useProjectStore } from '@/project/project-store';
import { remapRecoveryForAutoCommit } from '@/project/structural-command-persistence';
import {
  buildEditorProjectStateSnapshot,
  setLoadedEditorProjectState,
} from '@/workbench/project-editor-state';
import { create } from 'zustand';
import {
  beginTransaction as beginTransactionCore,
  commitTransaction as commitTransactionCore,
  createInitialCommandHistoryState,
  executeCommand as executeCommandCore,
  redoCommand as redoCommandCore,
  undoCommand as undoCommandCore,
  type CommandBusState,
} from './command-bus';
import type {
  CommandDiagnostic,
  CommandExecutionResult,
  CommandHistoryEntry,
  CommandHistoryState,
  CommandRequest,
  CommandTransactionRequest,
} from './command-types';
import {
  assertNativeProjection,
  confirmNativeCommand,
  nativeLocalizationTarget,
} from './native-command-execution';

interface CommandStoreState {
  history: CommandHistoryState;
  lastDiagnostics: CommandDiagnostic[];
  persistencePending: boolean;
  nativeWorkingRevision: number | null;
  nativeProjectSessionId: string | null;
  nativeProjectionRevision: number | null;
  nativeMutationPending: boolean;
  nativeMutationFailure: string | null;
  reconcileNativeExternalAsync: (
    owners: readonly string[],
    onAcknowledged: (
      result: import('../../main/services/native-authoring-worker-contract').NativeAuthoringPatchResult,
    ) => void,
  ) => Promise<CommandExecutionResult>;
  useNativeDiskUnitAsync: (
    saveUnitId: string,
    onAcknowledged: (
      result: import('../../main/services/native-authoring-worker-contract').NativeAuthoringPatchResult,
    ) => void,
  ) => Promise<CommandExecutionResult>;
  enableNativeCommandMode: (workingRevision: number) => void;
  executeCommandAsync: (request: CommandRequest) => Promise<CommandExecutionResult>;
  saveNativeUnitAsync: (
    saveUnitIds: string | string[],
    expectedProjectRevision: number,
    options: {
      keepMine?: boolean;
      comments?: 'keep' | 'remove' | 'cancel' | 'perEdit';
      textPaths?: string[];
      textContents?: Record<string, string>;
    },
    onAcknowledged?: (
      result: import('../../main/services/native-authoring-worker-contract').NativeAuthoringPatchResult,
    ) => void,
  ) => Promise<
    CommandExecutionResult & {
      commentImpacts?: import('../../main/services/native-authoring-worker-contract').NativeAuthoringPatchResult['commentImpacts'];
    }
  >;
  saveNativeTextAsync: (
    path: string,
    text: string,
    diskRevision: string,
    expectedProjectRevision: number,
  ) => Promise<{ ok: boolean; contentHash?: string; error?: string }>;
  stageNativeTextAsync: (
    path: string,
    text: string,
    diskRevision: string,
    expectedProjectRevision: number,
  ) => Promise<CommandExecutionResult>;
  executeCommandBatchAsync: (
    transaction: CommandTransactionRequest,
    requests: readonly CommandRequest[],
  ) => Promise<CommandExecutionResult>;
  undoAsync: () => Promise<CommandExecutionResult>;
  redoAsync: () => Promise<CommandExecutionResult>;
  executeCommand: (request: CommandRequest) => CommandExecutionResult;
  undo: () => CommandExecutionResult;
  redo: () => CommandExecutionResult;
  beginTransaction: (request: CommandTransactionRequest) => void;
  commitTransaction: () => CommandExecutionResult;
  cancelTransaction: () => void;
  resetCommandHistory: () => void;
  invalidateHistoryAfterCommittedFileMove: () => void;
  discardSaveUnitHistory: (saveUnitId: string) => void;
}

function nativeOnlyResult(message: string): CommandExecutionResult {
  return {
    ok: false,
    projectChanged: false,
    diagnostics: [{ severity: 'error', message }],
  };
}

const nativeRecordFamilies = new Set([
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

/** Physical trash identity is returned by the committed native journal.
 * Never synthesize a restore destination from a record ID or disk state. */
const nativeAssetTrashByCommandId = new Map<
  string,
  import('../../shared/project-asset-audit').ProjectAssetTrashMove[]
>();
const nativeLayoutCopyByCommandId = new Map<string, Record<string, string>>();

function layoutSourceFromRequest(request: CommandRequest): Record<string, string> {
  if (
    request.type !== 'entity.duplicateRecord' ||
    !request.payload ||
    typeof request.payload !== 'object' ||
    Array.isArray(request.payload)
  )
    return {};
  const data = request.payload as Record<string, unknown>;
  if (
    data.collection !== 'layouts' ||
    typeof data.sourceId !== 'string' ||
    typeof data.targetId !== 'string'
  )
    return {};
  return { [`layouts/${data.targetId}`]: `layouts/${data.sourceId}` };
}

function nativeAssetTransition(
  entry: CommandHistoryEntry | undefined,
  direction: 'command' | 'undo' | 'redo',
): import('../../shared/editor-tooling').ProjectWorkspaceCommitOptions['assetTransition'] {
  const operations = entry?.autoCommitPlan?.filesystemOperations.filter(
    (operation) => operation.kind !== 'preexisting-project-assets',
  );
  if (!operations?.length) return undefined;
  if (operations.length !== 1)
    throw new Error('Native structural Save requires one coherent Asset transition.');
  const operation = operations[0]!;
  const trash =
    operation.kind === 'trash-project-assets' ? direction !== 'undo' : direction === 'undo';
  if (trash) return { kind: 'trash', projectRelativePaths: operation.projectRelativePaths };
  if (direction === 'command' && operation.kind === 'staged-project-assets')
    return { kind: 'publish', projectRelativePaths: operation.projectRelativePaths };
  const moves = nativeAssetTrashByCommandId.get(entry!.id);
  if (!moves?.length || moves.length !== operation.projectRelativePaths.length)
    throw new Error('Native structural Asset restoration has no committed trash identity.');
  return { kind: 'restore', moves };
}

/** Derive the physical YAML owner selection from the accepted generic patches,
 * not the command name or a renderer-provided filesystem path. All owners
 * commit in one native journal, including reference and editor metadata edits. */
function nativeStructuralOwners(patches: readonly JsonPatchOperation[]): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const patch of patches) {
    const segments = parseJsonPointer(patch.path);
    const family = segments[0];
    let owner = 'project';
    let relative = patch.path;
    if (family === 'localization') {
      const target = nativeLocalizationTarget(patch.path);
      if (!target) throw new Error(`Unsupported native localization owner: ${patch.path}`);
      owner = target.owner;
      relative = target.relative;
    } else if (family && nativeRecordFamilies.has(family) && segments.length >= 2) {
      owner = `${family}/${segments[1]}`;
      relative = segments.length === 2 ? '/' : buildJsonPointer(segments.slice(2));
    } else if (family === 'editor' || family === 'traits') {
      owner = family;
      relative = segments.length === 1 ? '/' : buildJsonPointer(segments.slice(1));
    }
    (paths[owner] ??= []).push(relative);
  }
  return Object.fromEntries(
    Object.entries(paths).map(([owner, values]) => [
      owner,
      values.includes('/') ? ['/'] : [...new Set(values)].sort(),
    ]),
  );
}

/** One logical translation collection spans independently revisioned YAML
 * fragments. Expand a whole-collection edit to a *single batch* of physical
 * locale-owner patches rather than routing it into project.yaml or saving
 * fragments separately. Preserve the original editor undo/redo intent. */
export function nativeLocalizationFragmentPatches(
  patches: readonly JsonPatchOperation[],
  before: JsonValue,
  after: JsonValue,
): JsonPatchOperation[] {
  const result: JsonPatchOperation[] = [];
  for (const patch of patches) {
    if (patch.path !== '/localization/translations' && patch.path !== '/localization/assets') {
      result.push(patch);
      continue;
    }
    const collection = patch.path;
    const previous = hasJsonAtPointer(before, collection)
      ? getJsonAtPointer(before, collection)
      : {};
    const proposed = hasJsonAtPointer(after, collection) ? getJsonAtPointer(after, collection) : {};
    if (
      !previous ||
      typeof previous !== 'object' ||
      Array.isArray(previous) ||
      !proposed ||
      typeof proposed !== 'object' ||
      Array.isArray(proposed)
    )
      throw new Error('Localization collection must be an object of locale fragments.');
    const oldFragments = previous as Record<string, JsonValue>;
    const newFragments = proposed as Record<string, JsonValue>;
    for (const locale of [
      ...new Set([...Object.keys(oldFragments), ...Object.keys(newFragments)]),
    ].sort()) {
      const path = `${collection}/${locale.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (!Object.hasOwn(newFragments, locale)) {
        result.push({ op: 'remove', path });
      } else if (!Object.hasOwn(oldFragments, locale)) {
        result.push({ op: 'add', path, value: newFragments[locale]! });
      } else if (!jsonValuesEqual(oldFragments[locale]!, newFragments[locale]!)) {
        result.push({ op: 'replace', path, value: newFragments[locale]! });
      }
    }
  }
  return result;
}

/** This is the asynchronous production command boundary, not speculative
 * publication followed by an optional worker check. A candidate command,
 * undo or redo remains invisible until native acceptance and value parity. */
async function submitNativeCommand(
  proposal: ReturnType<typeof executeCommandCore>,
  patches: readonly import('@/project/json-patch').JsonPatchOperation[],
  kind: 'command' | 'undo' | 'redo',
  layoutCopySources?: Record<string, string>,
): Promise<CommandExecutionResult> {
  const state = useCommandStore.getState();
  const revision = state.nativeWorkingRevision;
  const project = useProjectStore.getState();
  const projectSessionId = project.projectSessionId;
  if (revision === null || !projectSessionId || !project.projectInstanceId)
    return nativeOnlyResult('Native Project session is not ready.');
  if (project.projectRevision !== state.nativeProjectionRevision) {
    const message = 'Renderer Project changed without a native acknowledgment.';
    useCommandStore.setState({ nativeMutationFailure: message });
    return nativeOnlyResult(message);
  }
  if (state.nativeMutationPending || state.nativeMutationFailure)
    return nativeOnlyResult(state.nativeMutationFailure || 'A native Project command is pending.');
  if (!proposal.ok || !proposal.projectChanged) return proposal;
  try {
    patches = nativeLocalizationFragmentPatches(patches, project.document!, proposal.document!);
  } catch (error) {
    return nativeOnlyResult(
      error instanceof Error ? error.message : 'Invalid localization patches.',
    );
  }
  let effectiveProposal = proposal;
  let plan = proposal.historyEntry?.autoCommitPlan;
  const originalPlan = plan;
  const convertToManual = (reason: string): boolean => {
    if (
      kind !== 'command' ||
      plan?.unsafeRebasePolicy !== 'convert-to-manual-save' ||
      !effectiveProposal.historyEntry
    )
      return false;
    // Staged imports must publish their bytes and metadata together; an
    // ordinary later Save cannot safely publish unowned binary files.
    if (plan.filesystemOperations.some((operation) => operation.kind === 'staged-project-assets'))
      return false;
    const entry = {
      ...effectiveProposal.historyEntry,
      persistencePolicy: 'manual-save' as const,
      autoCommitPlan: undefined,
    };
    effectiveProposal = {
      ...effectiveProposal,
      historyEntry: entry,
      diagnostics: [
        ...effectiveProposal.diagnostics,
        {
          severity: 'warning' as const,
          message: `Native auto-commit converted to manual Save: ${reason}`,
        },
      ],
      state: {
        ...effectiveProposal.state,
        history: {
          ...effectiveProposal.state.history,
          entries: effectiveProposal.state.history.entries.map((candidate) =>
            candidate.id === entry.id ? entry : candidate,
          ),
        },
      },
    };
    plan = undefined;
    return true;
  };
  let savedBaseline: JsonValue | null = null;
  if (plan) {
    if (!project.savedDocument)
      return nativeOnlyResult('Native structural Save requires a saved Project baseline.');
    // Whole-owner structural Saves must not silently persist earlier manual
    // edits in the same record. Preserve the owner's saved baseline rather
    // than letting an auto-commit absorb an unrelated dirty buffer.
    let overlap: string | null = null;
    for (const patch of patches) {
      const full = patch.path.endsWith('/-') ? patch.path.slice(0, -2) : patch.path;
      const workingHas = hasJsonAtPointer(project.document!, full);
      const savedHas = hasJsonAtPointer(project.savedDocument, full);
      if (
        workingHas !== savedHas ||
        (workingHas &&
          !jsonValuesEqual(
            getJsonAtPointer(project.document!, full),
            getJsonAtPointer(project.savedDocument, full),
          ))
      )
        overlap = full;
    }
    if (overlap && !convertToManual(`Overlapping unsaved edits at ${overlap}`))
      return nativeOnlyResult(
        `Native structural auto-commit overlaps unsaved edits at ${overlap}.`,
      );
  }
  if (plan) {
    try {
      savedBaseline = applyJsonPatch(
        project.savedDocument,
        kind === 'undo' ? plan.inverseBaselinePatches : plan.forwardBaselinePatches,
      ).document;
    } catch (error) {
      return nativeOnlyResult(
        error instanceof Error ? error.message : 'Native baseline cannot be updated.',
      );
    }
  }
  // Resolve physical paths and restore identity before staging a generic
  // patch. No unsupported Asset transition may strand a dirty native session.
  let structuralPathsByOwner: Record<string, string[]> | undefined;
  let assetTransition:
    | import('../../shared/editor-tooling').ProjectWorkspaceCommitOptions['assetTransition']
    | undefined;
  if (plan) {
    try {
      structuralPathsByOwner = nativeStructuralOwners(patches);
      if (!Object.keys(structuralPathsByOwner).length)
        throw new Error('Native structural Save has no changed YAML owners.');
      assetTransition = nativeAssetTransition(effectiveProposal.historyEntry, kind);
      if (effectiveProposal.historyEntry) {
        const planHints = Object.fromEntries(
          plan.identityRemap.flatMap(({ fromPath, toPath }) => {
            const from = (kind === 'undo' ? toPath : fromPath).match(
              /^\/layouts\/([a-z][a-z0-9-]*)$/u,
            );
            const to = (kind === 'undo' ? fromPath : toPath).match(
              /^\/layouts\/([a-z][a-z0-9-]*)$/u,
            );
            return from && to ? [[`layouts/${to[1]}`, `layouts/${from[1]}`]] : [];
          }),
        );
        layoutCopySources = {
          ...planHints,
          ...nativeLayoutCopyByCommandId.get(effectiveProposal.historyEntry.id),
          ...layoutCopySources,
        };
        if (kind === 'undo') {
          for (const patch of patches) {
            const match =
              patch.op === 'add' ? patch.path.match(/^\/layouts\/([a-z][a-z0-9-]*)$/u) : null;
            if (match) {
              const owner = `layouts/${match[1]}`;
              layoutCopySources[owner] ??= owner;
            }
          }
        }
        layoutCopySources = Object.fromEntries(
          Object.entries(layoutCopySources).filter(([owner]) =>
            patches.some((patch) => patch.op === 'add' && patch.path === `/${owner}`),
          ),
        );
      }
    } catch (error) {
      return nativeOnlyResult(
        error instanceof Error ? error.message : 'Invalid native structural Save.',
      );
    }
  }
  if (!plan && originalPlan && kind === 'command') {
    // Manual Save postpones persistence, not the provenance of copied Layout
    // source files that the working native patch will still need to validate.
    layoutCopySources = {
      ...Object.fromEntries(
        originalPlan.identityRemap.flatMap(({ fromPath, toPath }) => {
          const from = fromPath.match(/^\/layouts\/([a-z][a-z0-9-]*)$/u);
          const to = toPath.match(/^\/layouts\/([a-z][a-z0-9-]*)$/u);
          return from && to ? [[`layouts/${to[1]}`, `layouts/${from[1]}`]] : [];
        }),
      ),
      ...layoutCopySources,
    };
  }
  const generation = project.projectRevision;
  const instanceId = project.projectInstanceId;
  const historyAtSubmission = state.history;
  useCommandStore.setState({ nativeMutationPending: true });
  try {
    const confirmed = await confirmNativeCommand(
      busStateFromStores(state.history),
      effectiveProposal,
      patches,
      projectSessionId,
      revision,
      (sessionId, expected, next) =>
        window.noveltea.nativeProjectPatch(
          sessionId,
          expected,
          next,
          layoutCopySources && Object.keys(layoutCopySources).length
            ? layoutCopySources
            : undefined,
        ),
    );
    // A rejected generic patch did not stage a structural change. In
    // particular, it must never fall through to the physical Save attempt.
    if (!confirmed.result.ok || !confirmed.result.projectChanged) {
      useCommandStore.setState({
        nativeMutationPending: false,
        lastDiagnostics: confirmed.result.diagnostics,
      });
      return confirmed.result;
    }
    if (
      layoutCopySources &&
      Object.keys(layoutCopySources).length &&
      effectiveProposal.historyEntry &&
      kind === 'command'
    )
      nativeLayoutCopyByCommandId.set(effectiveProposal.historyEntry.id, layoutCopySources);
    let workingRevision = confirmed.workingRevision;
    if (plan && structuralPathsByOwner) {
      let saved = await window.noveltea.nativeProjectSaveUnit(
        projectSessionId,
        workingRevision,
        [],
        { structuralPathsByOwner, comments: 'keep', assetTransition },
      );
      if (!saved.accepted && saved.commentImpacts?.length) {
        const decision = await confirmProjectComments(saved.commentImpacts, plan.commandType);
        if (decision === 'delete')
          saved = await window.noveltea.nativeProjectSaveUnit(
            projectSessionId,
            workingRevision,
            [],
            { structuralPathsByOwner, comments: 'remove', assetTransition },
          );
        else if (decision !== 'cancel')
          throw new Error('Native structural comment approval returned an invalid decision.');
      }
      if (!saved.accepted) {
        // The YAML journal left the disk unchanged. Restore the native working
        // candidate before returning a normal command failure; never publish
        // a candidate whose physical auto-commit was rejected.
        const entry = effectiveProposal.historyEntry;
        const inverse = kind === 'undo' ? entry?.patches : entry?.inversePatches;
        if (!inverse?.length)
          throw new Error('Rejected native structural Save lacks a rollback patch.');
        const restored = await window.noveltea.nativeProjectPatch(
          projectSessionId,
          workingRevision,
          [...inverse],
        );
        if (!restored.accepted)
          throw new Error(
            `Native structural Save and rollback failed: ${saved.error}; ${restored.error}`,
          );
        assertNativeProjection(project.document!, inverse, restored);
        let restoredRevision = restored.snapshot.workingRevision;
        const stagedImport =
          kind === 'command'
            ? plan.filesystemOperations.find(
                (operation) => operation.kind === 'staged-project-assets',
              )
            : undefined;
        if (stagedImport && assetTransition?.kind === 'publish') {
          const cleanup = await window.noveltea.trashProjectAssetFiles(
            projectSessionId,
            stagedImport.projectRelativePaths,
          );
          if (!cleanup.ok)
            throw new Error(
              `Native structural Save rejected (${saved.error}); staged Asset cleanup failed: ${cleanup.error}`,
            );
        } else if (stagedImport) {
          // An importer may have already copied bytes into the Project before
          // asking the editor to commit metadata. Failed metadata persistence
          // must not leave those copied files behind as unowned active Assets.
          const cleanup = await window.noveltea.nativeProjectSaveUnit(
            projectSessionId,
            restoredRevision,
            [],
            {
              structuralPathsByOwner: {},
              assetTransition: {
                kind: 'trash',
                projectRelativePaths: stagedImport.projectRelativePaths,
              },
            },
          );
          if (!cleanup.accepted)
            throw new Error(
              `Native structural Save rejected (${saved.error}); staged Asset cleanup failed: ${cleanup.error}`,
            );
          restoredRevision = cleanup.snapshot.workingRevision;
        }
        useCommandStore.setState({
          nativeWorkingRevision: restoredRevision,
          nativeMutationPending: false,
          lastDiagnostics: [
            { severity: 'error', message: saved.error || 'Native structural Save rejected.' },
          ],
        });
        return nativeOnlyResult(saved.error || 'Native structural Save rejected.');
      }
      assertNativeProjection(effectiveProposal.document!, patches, saved);
      if (saved.assetTrashMoves?.length && effectiveProposal.historyEntry)
        nativeAssetTrashByCommandId.set(effectiveProposal.historyEntry.id, saved.assetTrashMoves);
      workingRevision = saved.snapshot.workingRevision;
    }
    const current = useProjectStore.getState();
    if (
      current.projectSessionId !== projectSessionId ||
      current.projectInstanceId !== instanceId ||
      current.projectRevision !== generation ||
      useCommandStore.getState().history !== historyAtSubmission ||
      useCommandStore.getState().nativeWorkingRevision !== revision
    )
      throw new Error(
        'Native Project changed while an editor command was awaiting acknowledgment.',
      );
    if (confirmed.result.projectChanged && !applyBusResult(confirmed.result, kind))
      throw new Error('Native Project accepted a change that the editor cannot publish.');
    if (savedBaseline) {
      const remaps =
        kind === 'undo'
          ? plan!.identityRemap.map(({ fromPath, toPath, fromSaveUnitId, toSaveUnitId }) => ({
              fromPath: toPath,
              toPath: fromPath,
              fromSaveUnitId: toSaveUnitId,
              toSaveUnitId: fromSaveUnitId,
            }))
          : plan!.identityRemap;
      const scriptSourcePaths = { ...project.scriptSourcePaths };
      for (const remap of remaps) {
        const from = remap.fromPath.match(/^\/scripts\/([a-z][a-z0-9-]*)$/u)?.[1];
        const to = remap.toPath.match(/^\/scripts\/([a-z][a-z0-9-]*)$/u)?.[1];
        if (!from || !to || !scriptSourcePaths[from]) continue;
        scriptSourcePaths[to] = scriptSourcePaths[from];
        delete scriptSourcePaths[from];
      }
      useProjectStore.getState().markSaved({ document: savedBaseline, scriptSourcePaths });
      if (remaps.length || plan!.discardRecoverySaveUnitIds.length) {
        const editorState = buildEditorProjectStateSnapshot();
        const recovery = remapRecoveryForAutoCommit(editorState.recovery, remaps);
        for (const id of kind === 'undo' ? [] : plan!.discardRecoverySaveUnitIds)
          delete recovery.saveUnitsById[id];
        setLoadedEditorProjectState({ ...editorState, recovery });
      }
    }
    useCommandStore.setState({
      history: confirmed.result.state.history,
      nativeWorkingRevision: workingRevision,
      nativeProjectionRevision: useProjectStore.getState().projectRevision,
      nativeMutationPending: false,
      lastDiagnostics: confirmed.result.diagnostics,
    });
    return confirmed.result;
  } catch (error) {
    // A lost/invalid acknowledgment may follow an accepted native mutation.
    // Never resume from a stale TS document or fall back to the old writer.
    const message = error instanceof Error ? error.message : 'Native Project command failed.';
    const latestProject = useProjectStore.getState();
    if (
      latestProject.projectInstanceId !== instanceId ||
      latestProject.projectSessionId !== projectSessionId ||
      useCommandStore.getState().nativeWorkingRevision !== revision
    )
      return nativeOnlyResult('Native Project command was superseded by another Project session.');
    useCommandStore.setState({
      nativeMutationPending: false,
      nativeMutationFailure: message,
      lastDiagnostics: [{ severity: 'error', message }],
    });
    return nativeOnlyResult(message);
  }
}

function busStateFromStores(history: CommandHistoryState): CommandBusState {
  const project = useProjectStore.getState();
  return {
    document: project.document,
    savedDocument: project.savedDocument,
    history,
    graphSnapshot: isAuthoringDependencyGraphServiceStarted()
      ? currentAuthoringGraphSnapshot()
      : null,
    projectInstanceId: project.projectInstanceId,
    projectRevision: project.projectRevision,
  };
}

function applyBusResult(
  result: ReturnType<typeof executeCommandCore>,
  kind: 'command' | 'transaction-step' | 'persistence-rollback' | 'undo' | 'redo' | 'replace',
) {
  if (result.document !== undefined) {
    return useProjectStore
      .getState()
      .replaceDocumentFromCommand(
        result.document as JsonValue,
        result.cursor ?? result.state.history.cursor,
        {
          kind,
          affectedPaths: result.affectedPaths ?? result.historyEntry?.affectedPaths ?? ['/'],
        },
      );
  } else if (
    result.state.document !== null &&
    result.state.history.cursor !== useProjectStore.getState().historyCursor
  ) {
    useProjectStore.getState().setHistoryCursor(result.state.history.cursor);
  }
  return true;
}

const structuralPersistenceQueue: Promise<void> = Promise.resolve();

// The UI can dispatch more than one editor intent before the native worker
// responds (typing, numeric steppers, drag commits). Construct each proposal
// against the *latest acknowledged* Project, never a speculative projection.
// The captured session identity keeps queued intents from leaking into a
// different Project, even if its revision happens to match.
const nativeCommandQueues = new Map<string, Promise<void>>();

function queueNativeCommand(
  run: () => Promise<CommandExecutionResult>,
): Promise<CommandExecutionResult> {
  const { projectSessionId, projectInstanceId } = useProjectStore.getState();
  const queueId = `${projectSessionId}:${projectInstanceId}`;
  const perform = async () => {
    const current = useProjectStore.getState();
    if (
      !projectSessionId ||
      !projectInstanceId ||
      current.projectSessionId !== projectSessionId ||
      current.projectInstanceId !== projectInstanceId ||
      useCommandStore.getState().nativeProjectSessionId !== projectSessionId
    )
      return nativeOnlyResult('Queued native command belongs to a superseded Project session.');
    return run();
  };
  const previous = nativeCommandQueues.get(queueId) ?? Promise.resolve();
  const result = previous.then(perform, perform);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  nativeCommandQueues.set(queueId, tail);
  void tail.then(() => {
    if (nativeCommandQueues.get(queueId) === tail) nativeCommandQueues.delete(queueId);
  });
  return result;
}

export function flushStructuralCommandPersistence(): Promise<void> {
  return structuralPersistenceQueue;
}

export const useCommandStore = create<CommandStoreState>()((set, get) => ({
  history: createInitialCommandHistoryState(),
  lastDiagnostics: [],
  persistencePending: false,
  nativeWorkingRevision: null,
  nativeProjectSessionId: null,
  nativeProjectionRevision: null,
  nativeMutationPending: false,
  nativeMutationFailure: null,
  enableNativeCommandMode: (workingRevision) => {
    if (!Number.isSafeInteger(workingRevision) || workingRevision < 0)
      throw new Error('Invalid initial native Project revision.');
    const projectSessionId = useProjectStore.getState().projectSessionId;
    if (!projectSessionId)
      throw new Error('Cannot enable native commands without an active Project.');
    useProjectStore.setState({ nativeSession: true });
    set({
      nativeProjectSessionId: projectSessionId,
      nativeWorkingRevision: workingRevision,
      nativeProjectionRevision: useProjectStore.getState().projectRevision,
      nativeMutationPending: false,
      nativeMutationFailure: null,
    });
  },
  reconcileNativeExternalAsync: async (owners, onAcknowledged) => {
    if (get().nativeWorkingRevision === null) return nativeOnlyResult('Not a native Project.');
    return queueNativeCommand(async () => {
      const project = useProjectStore.getState();
      const session = project.projectSessionId;
      const instance = project.projectInstanceId;
      let revision = get().nativeWorkingRevision;
      if (
        !session ||
        !instance ||
        revision === null ||
        get().nativeProjectSessionId !== session ||
        get().nativeProjectionRevision !== project.projectRevision ||
        get().nativeMutationFailure
      )
        return nativeOnlyResult('Native reconciliation has a stale editor projection.');
      set({ nativeMutationPending: true });
      let final:
        | import('../../main/services/native-authoring-worker-contract').NativeAuthoringPatchResult
        | null = null;
      const changed = new Set<string>();
      let failedOwner: string | null = null;
      let publicationAttempted = false;
      try {
        for (const owner of [...new Set(owners)].sort()) {
          failedOwner = owner;
          const result = await window.noveltea.nativeProjectReconcile(session, revision, owner);
          if (
            useProjectStore.getState().projectInstanceId !== instance ||
            useProjectStore.getState().projectRevision !== project.projectRevision ||
            get().nativeWorkingRevision !== revision
          )
            throw new Error('Native reconciliation was superseded by a Project edit.');
          if (!result.accepted)
            throw new Error(result.error || `Native reconciliation failed: ${owner}`);
          if (result.snapshot.workingRevision < revision)
            throw new Error('Native reconciliation returned an older working revision.');
          revision = result.snapshot.workingRevision;
          result.affectedRecords.forEach((affected) => changed.add(affected));
          final = result;
          // Keep the revision gate current during a multi-owner batch. The
          // renderer publication remains atomic at the end of this queue slot.
          set({ nativeWorkingRevision: revision });
        }
        if (final && changed.size) {
          publicationAttempted = true;
          onAcknowledged({ ...final, affectedRecords: [...changed].sort() });
          set({ nativeProjectionRevision: useProjectStore.getState().projectRevision });
        }
        set({ nativeMutationPending: false, lastDiagnostics: [] });
        return { ok: true, projectChanged: Boolean(changed.size), diagnostics: [] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Native reconciliation failed.';
        if (
          final &&
          changed.size &&
          !publicationAttempted &&
          useProjectStore.getState().projectInstanceId === instance &&
          useProjectStore.getState().projectRevision === project.projectRevision
        ) {
          try {
            publicationAttempted = true;
            onAcknowledged({ ...final, affectedRecords: [...changed].sort() });
            set({ nativeProjectionRevision: useProjectStore.getState().projectRevision });
          } catch {
            set({ nativeMutationFailure: 'Native reconciliation lost editor projection parity.' });
          }
        }
        if (
          publicationAttempted &&
          get().nativeProjectionRevision !== useProjectStore.getState().projectRevision
        )
          set({ nativeMutationFailure: 'Native reconciliation lost editor projection parity.' });
        set({ nativeMutationPending: false, lastDiagnostics: [{ severity: 'error', message }] });
        return {
          ...nativeOnlyResult(message),
          diagnostics: [
            { severity: 'error', message, ...(failedOwner ? { path: failedOwner } : {}) },
          ],
        };
      }
    });
  },
  useNativeDiskUnitAsync: async (saveUnitId, onAcknowledged) => {
    if (get().nativeWorkingRevision === null) return nativeOnlyResult('Not a native Project.');
    return queueNativeCommand(async () => {
      const project = useProjectStore.getState();
      const session = project.projectSessionId;
      const instance = project.projectInstanceId;
      const revision = get().nativeWorkingRevision;
      if (
        !session ||
        !instance ||
        revision === null ||
        get().nativeProjectSessionId !== session ||
        get().nativeProjectionRevision !== project.projectRevision ||
        get().nativeMutationFailure
      )
        return nativeOnlyResult('Native Use Disk has a stale editor projection.');
      set({ nativeMutationPending: true });
      try {
        const result = await window.noveltea.nativeProjectUseDiskUnit(
          session,
          revision,
          saveUnitId,
        );
        if (
          useProjectStore.getState().projectInstanceId !== instance ||
          useProjectStore.getState().projectRevision !== project.projectRevision ||
          get().nativeWorkingRevision !== revision
        )
          throw new Error('Native Use Disk was superseded by a Project edit.');
        if (!result.accepted) throw new Error(result.error || 'Native Use Disk rejected.');
        if (result.snapshot.workingRevision < revision)
          throw new Error('Native Use Disk returned an older working revision.');
        try {
          onAcknowledged(result);
        } catch (error) {
          set({ nativeMutationFailure: 'Native Use Disk lost editor projection parity.' });
          throw error;
        }
        // Native Use Disk already invalidated the worker's overlapping edits.
        // Prune the corresponding UI undo entries only after the native result
        // and its renderer projection have both been acknowledged. Calling the
        // legacy discardSaveUnitHistory() here deliberately freezes native edits.
        const history = get().history;
        const removedApplied = history.entries
          .slice(0, history.cursor + 1)
          .filter((entry) => entry.originSaveUnitId === saveUnitId).length;
        const entries = history.entries.filter((entry) => entry.originSaveUnitId !== saveUnitId);
        const cursor = Math.max(-1, history.cursor - removedApplied);
        useProjectStore.getState().setHistoryCursor(cursor);
        set({
          history: { ...history, entries, cursor },
          nativeMutationPending: false,
          nativeWorkingRevision: result.snapshot.workingRevision,
          nativeProjectionRevision: useProjectStore.getState().projectRevision,
          lastDiagnostics: [],
        });
        return { ok: true, projectChanged: true, diagnostics: [] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Native Use Disk failed.';
        set({ nativeMutationPending: false, lastDiagnostics: [{ severity: 'error', message }] });
        return nativeOnlyResult(message);
      }
    });
  },
  executeCommandAsync: async (request) => {
    if (get().nativeWorkingRevision === null)
      return nativeOnlyResult('Native Project session is required.');
    return queueNativeCommand(() => {
      if (get().nativeMutationFailure)
        return Promise.resolve(nativeOnlyResult(get().nativeMutationFailure!));
      if (get().history.activeTransaction)
        return Promise.resolve(
          nativeOnlyResult('Native Project transactions require asynchronous commit support.'),
        );
      const proposal = executeCommandCore(busStateFromStores(get().history), request);
      return submitNativeCommand(
        proposal,
        proposal.historyEntry?.patches ?? [],
        'command',
        layoutSourceFromRequest(request),
      );
    });
  },
  saveNativeUnitAsync: async (saveUnitIds, expectedProjectRevision, options, onAcknowledged) => {
    if (get().nativeWorkingRevision === null)
      return nativeOnlyResult('Native Project Save requires native authoring mode.');
    return queueNativeCommand(async () => {
      const state = get();
      const project = useProjectStore.getState();
      const session = project.projectSessionId;
      const instance = project.projectInstanceId;
      const revision = state.nativeWorkingRevision;
      if (state.nativeMutationFailure) return nativeOnlyResult(state.nativeMutationFailure);
      if (
        revision === null ||
        !session ||
        !instance ||
        state.nativeProjectSessionId !== session ||
        project.projectRevision !== expectedProjectRevision ||
        state.nativeProjectionRevision !== project.projectRevision
      )
        return nativeOnlyResult('Project changed before its native Save could begin.');
      set({ nativeMutationPending: true });
      try {
        const saved = await window.noveltea.nativeProjectSaveUnit(
          session,
          revision,
          saveUnitIds,
          options,
        );
        const current = useProjectStore.getState();
        if (
          current.projectSessionId !== session ||
          current.projectInstanceId !== instance ||
          current.projectRevision !== expectedProjectRevision ||
          get().nativeWorkingRevision !== revision
        )
          throw new Error('Native Project Save completed after its editor session changed.');
        if (!saved.accepted) {
          const fallback = nativeOnlyResult(saved.error || 'Native scoped Save rejected.');
          const nativeDiagnostics = saved.diagnosticsAdded?.length
            ? saved.diagnosticsAdded
            : (saved.snapshot?.diagnostics ?? []);
          const details = nativeDiagnostics.map((diagnostic) => ({
            severity: diagnostic.severity,
            code: diagnostic.code,
            path: diagnostic.path,
            message: diagnostic.sourcePath
              ? `${diagnostic.message} [${diagnostic.sourcePath}${diagnostic.line ? `:${diagnostic.line}` : ''}]`
              : diagnostic.message,
          }));
          // A declined transaction must still expose a blocking error when
          // the native owner provides warnings but no error-level diagnostic.
          const rejected = {
            ...fallback,
            diagnostics: [
              ...details,
              ...(details.some((diagnostic) => diagnostic.severity === 'error')
                ? []
                : fallback.diagnostics),
            ],
          };
          set({ nativeMutationPending: false, lastDiagnostics: rejected.diagnostics });
          return { ...rejected, commentImpacts: saved.commentImpacts };
        }
        if (saved.snapshot.workingRevision < revision)
          throw new Error('Native Save acknowledged an older working Project revision.');
        // Adopt the scoped saved baseline *while the shared mutation queue is
        // still held*. Otherwise a queued native editor command could publish
        // between the physical Save acknowledgment and the recovery rebase.
        onAcknowledged?.(saved);
        set({
          nativeMutationPending: false,
          nativeWorkingRevision: saved.snapshot.workingRevision,
          nativeProjectionRevision: useProjectStore.getState().projectRevision,
          lastDiagnostics: [],
        });
        return { ok: true, projectChanged: false, diagnostics: [] };
      } catch (error) {
        const current = useProjectStore.getState();
        if (current.projectSessionId !== session || current.projectInstanceId !== instance)
          return nativeOnlyResult('Native Save was superseded by another Project session.');
        const message = error instanceof Error ? error.message : 'Native Project Save failed.';
        set({
          nativeMutationPending: false,
          nativeMutationFailure: message,
          lastDiagnostics: [{ severity: 'error', message }],
        });
        return nativeOnlyResult(message);
      }
    });
  },
  saveNativeTextAsync: async (path, text, diskRevision, expectedProjectRevision) => {
    if (get().nativeWorkingRevision === null)
      return { ok: false, error: 'Native source Save requires native authoring mode.' };
    const result = await queueNativeCommand(async () => {
      const state = get();
      const project = useProjectStore.getState();
      const session = project.projectSessionId;
      const instance = project.projectInstanceId;
      const revision = state.nativeWorkingRevision;
      if (state.nativeMutationFailure) return nativeOnlyResult(state.nativeMutationFailure);
      if (
        revision === null ||
        !session ||
        !instance ||
        state.nativeProjectSessionId !== session ||
        state.nativeProjectionRevision !== project.projectRevision ||
        project.projectRevision !== expectedProjectRevision
      )
        return nativeOnlyResult('Project changed before its native source Save could begin.');
      set({ nativeMutationPending: true });
      try {
        const saved = await window.noveltea.nativeProjectSaveText(
          session,
          revision,
          path,
          diskRevision,
          text,
        );
        const current = useProjectStore.getState();
        if (
          current.projectSessionId !== session ||
          current.projectInstanceId !== instance ||
          current.projectRevision !== expectedProjectRevision ||
          get().nativeWorkingRevision !== revision
        )
          throw new Error('Native text Save completed after the Project changed.');
        if (saved.snapshot.workingRevision < revision)
          throw new Error('Native text Save acknowledged a stale revision.');
        if (saved.accepted && !saved.textSourceDiskRevisions?.[path])
          throw new Error('Native text Save omitted its committed exact source revision.');
        set({
          nativeWorkingRevision: saved.snapshot.workingRevision,
          nativeMutationPending: false,
          lastDiagnostics: saved.accepted
            ? []
            : [{ severity: 'error', message: saved.error || 'Native source Save refused.' }],
        });
        if (!saved.accepted) return nativeOnlyResult(saved.error || 'Native source Save refused.');
        return {
          ok: true,
          projectChanged: false,
          diagnostics: [],
          contentHash: saved.textSourceDiskRevisions![path],
        };
      } catch (error) {
        const current = useProjectStore.getState();
        if (current.projectSessionId !== session || current.projectInstanceId !== instance)
          return nativeOnlyResult('Native text Save belongs to a superseded session.');
        const message = error instanceof Error ? error.message : 'Native text Save failed.';
        set({
          nativeMutationPending: false,
          nativeMutationFailure: message,
          lastDiagnostics: [{ severity: 'error', message }],
        });
        return nativeOnlyResult(message);
      }
    });
    return {
      ok: result.ok,
      ...(result.ok && 'contentHash' in result && typeof result.contentHash === 'string'
        ? { contentHash: result.contentHash }
        : { error: result.diagnostics[0]?.message ?? 'Native source Save failed.' }),
    };
  },
  stageNativeTextAsync: async (path, text, diskRevision, expectedProjectRevision) => {
    if (get().nativeWorkingRevision === null)
      return nativeOnlyResult('Native source staging requires native authoring mode.');
    return queueNativeCommand(async () => {
      const state = get();
      const project = useProjectStore.getState();
      const session = project.projectSessionId;
      const instance = project.projectInstanceId;
      const revision = state.nativeWorkingRevision;
      if (state.nativeMutationFailure) return nativeOnlyResult(state.nativeMutationFailure);
      if (
        revision === null ||
        !session ||
        !instance ||
        state.nativeProjectSessionId !== session ||
        state.nativeProjectionRevision !== project.projectRevision ||
        expectedProjectRevision !== project.projectRevision
      )
        return nativeOnlyResult('Native Project changed before source staging began.');
      set({ nativeMutationPending: true });
      try {
        const staged = await window.noveltea.nativeProjectStageText(
          session,
          revision,
          path,
          diskRevision,
          text,
        );
        const current = useProjectStore.getState();
        if (
          current.projectSessionId !== session ||
          current.projectInstanceId !== instance ||
          current.projectRevision !== expectedProjectRevision ||
          get().nativeWorkingRevision !== revision
        )
          throw new Error('Native source stage completed after the Project changed.');
        if (staged.snapshot.workingRevision < revision)
          throw new Error('Native source stage acknowledged an old working revision.');
        if (staged.accepted && staged.textSourceStaged === undefined)
          throw new Error('Native source stage acknowledgment lacked staging evidence.');
        set({
          nativeMutationPending: false,
          nativeWorkingRevision: staged.snapshot.workingRevision,
          lastDiagnostics: staged.accepted
            ? []
            : [{ severity: 'error', message: staged.error || 'Native source stage rejected.' }],
        });
        return staged.accepted
          ? { ok: true, projectChanged: false, diagnostics: [] }
          : nativeOnlyResult(staged.error || 'Native source stage rejected.');
      } catch (error) {
        const current = useProjectStore.getState();
        if (current.projectSessionId !== session || current.projectInstanceId !== instance)
          return nativeOnlyResult('Native source stage belongs to a superseded Project.');
        const message = error instanceof Error ? error.message : 'Native source stage failed.';
        set({
          nativeMutationPending: false,
          nativeMutationFailure: message,
          lastDiagnostics: [{ severity: 'error', message }],
        });
        return nativeOnlyResult(message);
      }
    });
  },
  executeCommandBatchAsync: async (transaction, requests) => {
    if (get().nativeWorkingRevision === null)
      return nativeOnlyResult('Native Project session is required.');
    return queueNativeCommand(() => {
      if (get().nativeMutationFailure)
        return Promise.resolve(nativeOnlyResult(get().nativeMutationFailure!));
      if (get().history.activeTransaction)
        return Promise.resolve(nativeOnlyResult('Another Project transaction is active.'));
      const initial = busStateFromStores(get().history);
      let working = beginTransactionCore(initial, transaction);
      if (!working.history.activeTransaction)
        return Promise.resolve(nativeOnlyResult('Cannot start native command transaction.'));
      for (const request of requests) {
        const step = executeCommandCore(working, request);
        if (!step.ok)
          return Promise.resolve({ ...step, document: undefined, projectChanged: false });
        working = step.state;
      }
      const proposal = commitTransactionCore(working);
      return submitNativeCommand(
        proposal,
        proposal.historyEntry?.patches ?? [],
        'command',
        Object.assign({}, ...requests.map(layoutSourceFromRequest)),
      );
    });
  },
  undoAsync: async () => {
    if (get().nativeWorkingRevision === null)
      return nativeOnlyResult('Native Project session is required.');
    return queueNativeCommand(() => {
      if (get().nativeMutationFailure)
        return Promise.resolve(nativeOnlyResult(get().nativeMutationFailure!));
      const proposal = undoCommandCore(busStateFromStores(get().history));
      return submitNativeCommand(proposal, proposal.historyEntry?.inversePatches ?? [], 'undo');
    });
  },
  redoAsync: async () => {
    if (get().nativeWorkingRevision === null)
      return nativeOnlyResult('Native Project session is required.');
    return queueNativeCommand(() => {
      if (get().nativeMutationFailure)
        return Promise.resolve(nativeOnlyResult(get().nativeMutationFailure!));
      const proposal = redoCommandCore(busStateFromStores(get().history));
      return submitNativeCommand(proposal, proposal.historyEntry?.patches ?? [], 'redo');
    });
  },
  executeCommand: (_request) => {
    return nativeOnlyResult('Native Project commands must use executeCommandAsync.');
  },
  undo: () => {
    return nativeOnlyResult('Native Project undo must use undoAsync.');
  },
  redo: () => {
    return nativeOnlyResult('Native Project redo must use redoAsync.');
  },
  beginTransaction: (_request) => {
    return;
  },
  commitTransaction: () => {
    return nativeOnlyResult('Native Project transactions require asynchronous commit support.');
  },
  cancelTransaction: () => {
    return;
  },
  resetCommandHistory: () =>
    set((current) => {
      nativeAssetTrashByCommandId.clear();
      nativeLayoutCopyByCommandId.clear();
      // A history reset within a native Project must never silently reactivate
      // the retired TypeScript command writer. Only unloading/switching to a
      // different session can clear native authority.
      const sameSession =
        current.nativeProjectSessionId !== null &&
        current.nativeProjectSessionId === useProjectStore.getState().projectSessionId;
      return {
        history: createInitialCommandHistoryState(),
        lastDiagnostics: [],
        persistencePending: false,
        nativeProjectSessionId: sameSession ? current.nativeProjectSessionId : null,
        nativeWorkingRevision: sameSession ? current.nativeWorkingRevision : null,
        nativeProjectionRevision: sameSession ? current.nativeProjectionRevision : null,
        nativeMutationPending: sameSession ? current.nativeMutationPending : false,
        nativeMutationFailure: sameSession ? current.nativeMutationFailure : null,
      };
    }),
  // Filesystem renames are committed outside the command bus. Old forward/inverse
  // patches can restore paths that no longer exist, including through redo or an
  // active transaction. Invalidate the history at the physical commit boundary.
  invalidateHistoryAfterCommittedFileMove: () => {
    set({
      // Physical source moves are owned by the native host. An undo entry
      // created before that move cannot safely replay the old source path;
      // drop the obsolete history after the committed source reconciliation.
      history: createInitialCommandHistoryState(),
      lastDiagnostics: [],
    });
  },
  discardSaveUnitHistory: (_saveUnitId) => {
    set({
      nativeMutationFailure: 'Legacy Save-unit history changes are unavailable for native Project.',
    });
    return;
  },
}));

export function selectCanUndo(state: Pick<CommandStoreState, 'history'>) {
  return state.history.cursor >= 0 && !state.history.activeTransaction;
}

export function selectCanRedo(state: Pick<CommandStoreState, 'history'>) {
  return (
    state.history.cursor < state.history.entries.length - 1 && !state.history.activeTransaction
  );
}

export function selectVisibleCommandHistory(
  state: Pick<CommandStoreState, 'history'>,
): CommandHistoryEntry[] {
  return state.history.entries;
}
