import path from 'node:path';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import {
  nativeAuthoringEventSchema,
  type NativeAuthoringCleanValidation,
  type NativeAuthoringCommand,
  type NativeAuthoringEvent,
  type NativeAuthoringPreparation,
} from './native-authoring-worker-contract';
import type { ActiveProjectSessionService } from './active-project-session-service';

type Event = NativeAuthoringEvent;
type Snapshot = Extract<Event, { type: 'snapshot' }>;
type Delta = Extract<Event, { type: 'delta' }>;
type Response = Extract<Event, { type: 'response' }>;
type Command = NativeAuthoringCommand extends infer T
  ? T extends NativeAuthoringCommand
    ? Omit<T, 'requestId'>
    : never
  : never;
interface WorkerTransport {
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  postMessage(value: unknown): void;
  terminate(): Promise<number>;
}

interface OpenSession {
  worker: WorkerTransport;
  exited: boolean;
  sessionId: string;
  generation: number;
  ready: boolean;
  sequence: number;
  lastResponse: number;
  requestId: number;
  pending: Map<
    number,
    { resolve: (value: Response['result']) => void; reject: (error: Error) => void }
  >;
  startResolve: (event: Snapshot) => void;
  startReject: (error: Error) => void;
}

export interface NativeAuthoringSessionOptions {
  addonPath: string;
  workerScript?: string;
  pollIntervalMs?: number;
  createWorker?: (script: string, options: WorkerOptions) => WorkerTransport;
}

/**
 * Opt-in certification bridge. Only the trusted main admission controller
 * can expose guarded native operations to preload/renderer IPC. The trusted
 * main-owned active session is the only source of the worker's filesystem root.
 */
export class NativeAuthoringSessionBridge {
  private current: OpenSession | null = null;
  private generation = 0;
  private readonly terminations = new Set<Promise<void>>();
  private readonly subscribers = new Set<(delta: Delta) => void>();
  private readonly failures = new Set<(error: Error) => void>();

  constructor(
    private readonly authority: Pick<
      ActiveProjectSessionService,
      'requireActiveProjectRoot' | 'isCurrent'
    >,
    private readonly options: NativeAuthoringSessionOptions,
  ) {}

  subscribe(handler: (delta: Delta) => void): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  onFailure(handler: (error: Error) => void): () => void {
    this.failures.add(handler);
    return () => this.failures.delete(handler);
  }

  open(projectSessionId: string): Promise<Snapshot> {
    // Authorization precedes Worker construction and is checked again for every reply.
    let root: string;
    try {
      root = this.authority.requireActiveProjectRoot(projectSessionId);
    } catch (error) {
      return Promise.reject(error);
    }
    this.close();
    const generation = ++this.generation;
    const script =
      this.options.workerScript ??
      path.join(__dirname, '../authoring-worker/native-authoring-worker.cjs');
    const create =
      this.options.createWorker ??
      ((filename: string, options: WorkerOptions) => new Worker(filename, options));
    return new Promise<Snapshot>((resolve, reject) => {
      let worker: WorkerTransport;
      try {
        worker = create(script, {
          workerData: {
            root,
            sessionId: projectSessionId,
            generation,
            addonPath: this.options.addonPath,
            pollIntervalMs: this.options.pollIntervalMs ?? 200,
          },
        });
      } catch (error) {
        reject(error);
        return;
      }
      const state: OpenSession = {
        worker,
        exited: false,
        sessionId: projectSessionId,
        generation,
        ready: false,
        sequence: 0,
        requestId: 0,
        lastResponse: 0,
        pending: new Map(),
        startResolve: resolve,
        startReject: reject,
      };
      this.current = state;
      worker.on('message', (raw) => this.receive(state, raw));
      worker.on('error', (error) => this.fail(state, error));
      worker.on('exit', (code) => {
        state.exited = true;
        this.fail(state, new Error(`Native Project worker exited (${code}).`));
      });
    });
  }

  request(
    command: Extract<Command, { operation: 'prepareWorking' }>,
  ): Promise<NativeAuthoringPreparation>;
  request(
    command: Extract<Command, { operation: 'prepareCompleteWorking' }>,
  ): Promise<NativeAuthoringPreparation>;
  request(
    command: Extract<Command, { operation: 'semanticGraph' }>,
  ): Promise<import('./native-authoring-worker-contract').NativeSemanticGraph>;
  request(
    command: Extract<Command, { operation: 'validateClean' }>,
  ): Promise<NativeAuthoringCleanValidation>;
  request(
    command: Exclude<
      Command,
      { operation: 'prepareWorking' | 'prepareCompleteWorking' | 'validateClean' | 'semanticGraph' }
    >,
  ): Promise<
    Exclude<Response['result'], NativeAuthoringPreparation | NativeAuthoringCleanValidation>
  >;
  async request(command: Command): Promise<Response['result']> {
    const state = this.current;
    if (!state || !state.ready || !this.authority.isCurrent(state.sessionId))
      throw new Error('Native Project session is unavailable or stale.');
    const requestId = ++state.requestId;
    return new Promise<Response['result']>((resolve, reject) => {
      state.pending.set(requestId, { resolve, reject });
      try {
        state.worker.postMessage({ ...command, requestId });
      } catch (error) {
        state.pending.delete(requestId);
        reject(error);
      }
    });
  }

  close(): void {
    const old = this.current;
    if (!old) return;
    this.current = null;
    this.generation++;
    this.release(old, new Error('Native Project session closed or superseded.'));
  }

  /** Close synchronously to revoke the session, then wait for native handles to be released. */
  async closeAndWait(): Promise<void> {
    this.close();
    await Promise.all(
      [...this.terminations].map((termination) => termination.catch(() => undefined)),
    );
  }

  private receive(state: OpenSession, raw: unknown): void {
    if (!this.owns(state)) return;
    const parsed = nativeAuthoringEventSchema.safeParse(raw);
    if (!parsed.success) {
      this.fail(state, new Error('Invalid native Project worker event.'));
      return;
    }
    const event = parsed.data;
    if (event.sessionId !== state.sessionId || event.generation !== state.generation) {
      this.fail(state, new Error('Native Project worker identity mismatch.'));
      return;
    }
    if (event.type === 'failure') {
      this.fail(state, new Error(event.error));
    } else if (event.type === 'snapshot') {
      if (state.ready) {
        this.fail(state, new Error('Duplicate initial native Project snapshot.'));
        return;
      }
      state.ready = true;
      state.startResolve(event);
    } else if (event.type === 'delta') {
      if (!state.ready || event.sequence !== state.sequence + 1) {
        this.fail(state, new Error('Out-of-order native Project delta.'));
        return;
      }
      state.sequence = event.sequence;
      for (const listener of this.subscribers) {
        try {
          listener(event);
        } catch {
          /* Subscribers must not break worker ownership. */
        }
      }
    } else {
      const pending = state.pending.get(event.requestId);
      if (!state.ready || event.requestId !== state.lastResponse + 1 || !pending) {
        this.fail(state, new Error('Out-of-order native Project response.'));
        return;
      }
      // The graph DTO is independently scoped inside the response envelope;
      // a stale/cross-Project payload must not be admitted merely because
      // the worker transport's outer event header is current.
      const result = event.result;
      if (
        typeof result === 'object' &&
        result !== null &&
        'nodes' in result &&
        'edges' in result &&
        'occurrences' in result &&
        'projectSessionId' in result &&
        (result.projectSessionId !== state.sessionId || result.generation !== state.generation)
      ) {
        this.fail(state, new Error('Native Project semantic graph identity mismatch.'));
        return;
      }
      state.lastResponse = event.requestId;
      state.pending.delete(event.requestId);
      pending.resolve(event.result);
    }
  }

  private owns(state: OpenSession): boolean {
    if (this.current !== state || state.generation !== this.generation) return false;
    if (!this.authority.isCurrent(state.sessionId)) {
      this.close();
      return false;
    }
    return true;
  }

  private fail(state: OpenSession, error: Error): void {
    if (this.current !== state) return;
    this.current = null;
    this.generation++;
    this.release(state, error);
    for (const listener of this.failures) {
      try {
        listener(error);
      } catch {
        /* Failure reporting is best effort. */
      }
    }
  }

  private release(state: OpenSession, error: Error): void {
    if (!state.ready) state.startReject(error);
    for (const pending of state.pending.values()) pending.reject(error);
    state.pending.clear();
    const termination = new Promise<void>((resolve) => {
      if (state.exited) {
        resolve();
        return;
      }
      let finished = false;
      const complete = () => {
        if (finished) return;
        finished = true;
        clearTimeout(fallback);
        resolve();
      };
      // Keep a bounded fallback for a wedged or older worker that does not
      // understand shutdown. Normal close must not interrupt a native call.
      const fallback = setTimeout(() => {
        void state.worker
          .terminate()
          .catch(() => undefined)
          .then(complete);
      }, 5000);
      state.worker.on('exit', complete);
      try {
        state.worker.postMessage({ type: 'shutdown' });
      } catch {
        void state.worker
          .terminate()
          .catch(() => undefined)
          .then(complete);
      }
    });
    this.terminations.add(termination);
    void termination.then(
      () => this.terminations.delete(termination),
      () => this.terminations.delete(termination),
    );
  }
}
