import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import {
  nativeAuthoringCommandSchema,
  nativeAuthoringObservationSchema,
  nativeAuthoringResultSchema,
  nativeAuthoringSnapshotSchema,
  type NativeAuthoringEvent,
} from './native-authoring-worker-contract';

interface NativeBinding {
  open(root: string): unknown;
  close(handle: unknown): void;
  snapshot(handle: unknown): string;
  observe(handle: unknown): string;
  hint(handle: unknown, path: string): void;
  coverageLost(handle: unknown): void;
  patch(handle: unknown, revision: number, operations: string): string;
  save(handle: unknown, revision: string): string;
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
      case 'patch':
        result = {
          ...identity,
          type: 'response',
          requestId: command.requestId,
          result: nativeAuthoringResultSchema.parse(
            JSON.parse(
              binding.patch(handle, command.expectedRevision, JSON.stringify(command.patches)),
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
