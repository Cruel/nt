import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import {
  nativeAuthoringCleanValidationSchema,
  nativeAuthoringCommandSchema,
  nativeAuthoringObservationSchema,
  nativeAuthoringResultSchema,
  nativeAuthoringPreparationSchema,
  nativeAuthoringSnapshotSchema,
  nativeSemanticGraphSchema,
  type NativeAuthoringEvent,
} from './native-authoring-worker-contract';

interface NativeBinding {
  open(root: string): unknown;
  close(handle: unknown): void;
  snapshot(handle: unknown): string;
  validateClean(handle: unknown): string;
  inspect(handle: unknown, owner: string): string;
  reconcile(handle: unknown, owner: string): string;
  useDisk(handle: unknown, revision: number, owner: string, paths?: string): string;
  saveOwners(
    handle: unknown,
    revision: number,
    owners: string,
    keepMine: boolean,
    comments: string,
    paths?: string,
    textPaths?: string,
    assetTransition?: string,
  ): string;
  mutateSourceDirectory(
    handle: unknown,
    revision: number,
    kind: string,
    from: string,
    to: string,
  ): string;
  restoreConflicts(handle: unknown, revision: number, conflicts: string): string;
  useDiskOwners(handle: unknown, revision: number, paths: string): string;
  observe(handle: unknown): string;
  hint(handle: unknown, path: string): void;
  coverageLost(handle: unknown): void;
  patch(
    handle: unknown,
    revision: number,
    operations: string,
    preconditions?: string,
    layoutCopySources?: string,
  ): string;
  save(handle: unknown, revision: string): string;
  prepareWorking(handle: unknown, revision: number, testId: string): string;
  prepareCompleteWorking(handle: unknown, revision: number, testId: string): string;
  semanticGraph(handle: unknown, revision: number): string;
  stageTextSource(
    handle: unknown,
    revision: number,
    path: string,
    text: string,
    diskPrecondition?: string,
  ): string;
  saveTextSources(handle: unknown, revision: number, paths: string, preconditions: string): string;
}

interface WorkerStartup {
  addonPath: string;
  root: string;
  sessionId: string;
  generation: number;
  pollIntervalMs: number;
}

const parent = parentPort!;
if (!parent) throw new Error('Native authoring worker requires a parent.');
const start = workerData as WorkerStartup;
const identity = { sessionId: start.sessionId, generation: start.generation };
const send = (event: NativeAuthoringEvent) => parent.postMessage(event);
let handle: unknown;
let binding: NativeBinding | undefined;
let stopped = false;
let sequence = 0;
let lastStatus: string | null = null;

function fail(error: unknown) {
  if (stopped) return;
  stopped = true;
  clearInterval(poller);
  send({ ...identity, type: 'failure', error: String(error) });
  if (binding && handle !== undefined) binding.close(handle);
  parent.close();
}

function observe() {
  if (!binding || handle === undefined) throw new Error('Native session is unavailable.');
  const observation = nativeAuthoringObservationSchema.parse(JSON.parse(binding.observe(handle)));
  const changedSourcePaths = [
    ...new Set([...observation.added, ...observation.changed, ...observation.removed]),
  ].sort();
  const changedRecords = [
    ...new Set(
      changedSourcePaths
        .map((value) => {
          const match = /^records\/([a-z]+)\/([a-z0-9-]+)\.yaml$/u.exec(value);
          return match ? `${match[1]}/${match[2]}` : value === 'project.yaml' ? 'project' : '';
        })
        .filter(Boolean),
    ),
  ].sort();
  const status = JSON.stringify({
    authoritative: observation.authoritative,
    scopedAuthority: observation.scopedAuthority,
    error: observation.error,
    invalidSources: observation.invalidSources,
    recordDiagnostics: observation.recordDiagnostics,
  });
  const firstUnhealthy =
    lastStatus === null && (!observation.authoritative || observation.invalidSources.length > 0);
  const statusChanged = lastStatus !== null && status !== lastStatus;
  lastStatus = status;
  if (changedSourcePaths.length || statusChanged || firstUnhealthy) {
    sequence++;
    send({ ...identity, type: 'delta', sequence, observation, changedRecords, changedSourcePaths });
  }
  return observation;
}

// JS and native operations are serialized on this dedicated worker's event loop.
// The native observer verifies exact source bytes; OS notifications are only hints.
const poller = setInterval(
  () => {
    try {
      if (!stopped) observe();
    } catch (error) {
      fail(error);
    }
  },
  Math.max(50, start.pollIntervalMs),
);

try {
  binding = createRequire(start.addonPath)(start.addonPath) as NativeBinding;
  handle = binding.open(start.root);
  const snapshot = nativeAuthoringSnapshotSchema.parse(JSON.parse(binding.snapshot(handle)));
  send({ ...identity, type: 'snapshot', sequence: 0, snapshot });
} catch (error) {
  fail(error);
}

parent.on('message', (raw: unknown) => {
  if (stopped || !binding || handle === undefined) return;
  try {
    const command = nativeAuthoringCommandSchema.parse(raw);
    let result: NativeAuthoringEvent & { type: 'response' };
    switch (command.operation) {
      case 'semanticGraph':
        result = {
          ...identity,
          type: 'response',
          requestId: command.requestId,
          result: nativeSemanticGraphSchema.parse({
            ...JSON.parse(binding.semanticGraph(handle, command.expectedRevision)),
            projectSessionId: start.sessionId,
            generation: start.generation,
          }),
        };
        break;
      case 'validateClean':
        result = {
          ...identity,
          type: 'response',
          requestId: command.requestId,
          result: nativeAuthoringCleanValidationSchema.parse(
            JSON.parse(binding.validateClean(handle)),
          ),
        };
        break;
      case 'prepareWorking':
        result = {
          ...identity,
          type: 'response',
          requestId: command.requestId,
          result: nativeAuthoringPreparationSchema.parse(
            JSON.parse(binding.prepareWorking(handle, command.expectedRevision, command.testId)),
          ),
        };
        break;
      case 'prepareCompleteWorking':
        result = {
          ...identity,
          type: 'response',
          requestId: command.requestId,
          result: nativeAuthoringPreparationSchema.parse(
            JSON.parse(
              binding.prepareCompleteWorking(handle, command.expectedRevision, command.testId),
            ),
          ),
        };
        break;
      case 'stageTextSource':
        result = {
          ...identity,
          type: 'response',
          requestId: command.requestId,
          result: nativeAuthoringResultSchema.parse(
            JSON.parse(
              binding.stageTextSource(
                handle,
                command.expectedRevision,
                command.path,
                command.text,
                ...(command.diskPrecondition !== undefined ? [command.diskPrecondition] : []),
              ),
            ),
          ),
        };
        break;
      case 'saveTextSources':
        result = {
          ...identity,
          type: 'response',
          requestId: command.requestId,
          result: nativeAuthoringResultSchema.parse(
            JSON.parse(
              binding.saveTextSources(
                handle,
                command.expectedRevision,
                JSON.stringify(command.paths),
                JSON.stringify(command.diskPreconditions),
              ),
            ),
          ),
        };
        break;
      case 'observe':
        result = { ...identity, type: 'response', requestId: command.requestId, result: observe() };
        break;
      case 'hint':
        binding.hint(handle, command.path);
        result = { ...identity, type: 'response', requestId: command.requestId, result: null };
        break;
      case 'coverageLost':
        binding.coverageLost(handle);
        result = { ...identity, type: 'response', requestId: command.requestId, result: null };
        break;
      case 'inspect':
        result = {
          ...identity,
          type: 'response',
          requestId: command.requestId,
          result: nativeAuthoringResultSchema.parse(
            JSON.parse(binding.inspect(handle, command.owner)),
          ),
        };
        break;
      case 'reconcile':
        result = {
          ...identity,
          type: 'response',
          requestId: command.requestId,
          result: nativeAuthoringResultSchema.parse(
            JSON.parse(binding.reconcile(handle, command.owner)),
          ),
        };
        break;
      case 'useDisk':
        result = {
          ...identity,
          type: 'response',
          requestId: command.requestId,
          result: nativeAuthoringResultSchema.parse(
            JSON.parse(
              command.paths
                ? binding.useDisk(
                    handle,
                    command.expectedRevision,
                    command.owner,
                    JSON.stringify(command.paths),
                  )
                : binding.useDisk(handle, command.expectedRevision, command.owner),
            ),
          ),
        };
        break;
      case 'mutateSourceDirectory':
        result = {
          ...identity,
          type: 'response',
          requestId: command.requestId,
          result: nativeAuthoringResultSchema.parse(
            JSON.parse(
              binding.mutateSourceDirectory(
                handle,
                command.expectedRevision,
                command.kind,
                command.from,
                command.to,
              ),
            ),
          ),
        };
        break;
      case 'saveOwners':
        result = {
          ...identity,
          type: 'response',
          requestId: command.requestId,
          result: nativeAuthoringResultSchema.parse(
            JSON.parse(
              binding.saveOwners(
                handle,
                command.expectedRevision,
                JSON.stringify(command.owners),
                command.keepMine,
                command.comments,
                ...(command.assetTransition
                  ? [
                      JSON.stringify(command.pathsByOwner ?? {}),
                      JSON.stringify(command.textPaths ?? []),
                      JSON.stringify(command.assetTransition),
                    ]
                  : command.textPaths
                    ? [
                        JSON.stringify(command.pathsByOwner ?? {}),
                        JSON.stringify(command.textPaths),
                      ]
                    : command.pathsByOwner
                      ? [JSON.stringify(command.pathsByOwner)]
                      : []),
              ),
            ),
          ),
        };
        break;
      case 'restoreConflicts':
        result = {
          ...identity,
          type: 'response',
          requestId: command.requestId,
          result: nativeAuthoringResultSchema.parse(
            JSON.parse(
              binding.restoreConflicts(
                handle,
                command.expectedRevision,
                JSON.stringify(command.conflicts),
              ),
            ),
          ),
        };
        break;
      case 'useDiskOwners':
        result = {
          ...identity,
          type: 'response',
          requestId: command.requestId,
          result: nativeAuthoringResultSchema.parse(
            JSON.parse(
              binding.useDiskOwners(
                handle,
                command.expectedRevision,
                JSON.stringify(command.pathsByOwner),
              ),
            ),
          ),
        };
        break;
      case 'patch':
        result = {
          ...identity,
          type: 'response',
          requestId: command.requestId,
          result: nativeAuthoringResultSchema.parse(
            JSON.parse(
              command.layoutCopySources
                ? binding.patch(
                    handle,
                    command.expectedRevision,
                    JSON.stringify(command.patches),
                    JSON.stringify(command.diskPreconditions ?? {}),
                    JSON.stringify(command.layoutCopySources),
                  )
                : command.diskPreconditions
                  ? binding.patch(
                      handle,
                      command.expectedRevision,
                      JSON.stringify(command.patches),
                      JSON.stringify(command.diskPreconditions),
                    )
                  : binding.patch(
                      handle,
                      command.expectedRevision,
                      JSON.stringify(command.patches),
                    ),
            ),
          ),
        };
        break;
      case 'save':
        result = {
          ...identity,
          type: 'response',
          requestId: command.requestId,
          result: nativeAuthoringResultSchema.parse(
            JSON.parse(binding.save(handle, command.diskRevision)),
          ),
        };
        break;
    }
    send(result);
  } catch (error) {
    fail(error);
  }
});
