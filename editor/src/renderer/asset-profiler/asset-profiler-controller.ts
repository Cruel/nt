import type { AssetProfilerWirePayload } from '../../shared/asset-profiler-protocol';
import {
  type AssetProfilerApplyResult,
  type AssetProfilerStore,
  useAssetProfilerStore,
} from './asset-profiler-store';

export interface AssetProfilerRequestCursor {
  sessionId: bigint;
  afterSequence: bigint;
}

export type AssetProfilerRequest = (
  cursor?: AssetProfilerRequestCursor,
) => Promise<AssetProfilerWirePayload>;

interface AssetProfilerScheduler {
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (timer: number) => void;
}

interface AssetProfilerControllerOptions {
  getStore?: () => AssetProfilerStore;
  scheduler?: AssetProfilerScheduler;
}

interface AssetProfilerTransport {
  key: unknown;
  request: AssetProfilerRequest;
}

function errorCode(error: unknown) {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Asset profiler request failed.';
}

function isTerminalProtocolError(code: string | undefined) {
  return (
    code === 'asset-profiler.invalid-payload' ||
    code === 'asset-profiler.unsupported-schema' ||
    code === 'asset-profiler.missing-payload' ||
    code === 'asset-profiler.duplicate-payload'
  );
}

export class AssetProfilerPollingController {
  private readonly getStore: () => AssetProfilerStore;
  private readonly scheduler: AssetProfilerScheduler;
  private transport: AssetProfilerTransport | null = null;
  private timer: number | null = null;
  private generation = 0;
  private inFlight = false;
  private requestAfterFlight = false;
  private forceFull = true;
  private panelVisible = false;
  private stoppedForProtocolError = false;

  constructor(options: AssetProfilerControllerOptions = {}) {
    this.getStore = options.getStore ?? (() => useAssetProfilerStore.getState());
    this.scheduler =
      options.scheduler ??
      ({
        setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clearTimeout: (timer) => window.clearTimeout(timer),
      } satisfies AssetProfilerScheduler);
  }

  setTransport({
    key,
    request,
    connected,
    supported,
  }: {
    key: unknown;
    request: AssetProfilerRequest | null;
    connected: boolean;
    supported: boolean;
  }) {
    if (!connected || !request) {
      if (this.transport === null && this.getStore().status === 'disconnected') return;
      this.replaceTransport(null, 'disconnected');
      return;
    }
    if (!supported) {
      if (this.transport === null && this.getStore().status === 'unsupported') return;
      this.replaceTransport(null, 'unsupported');
      return;
    }
    const currentTransport = this.transport;
    if (currentTransport && currentTransport.key === key && currentTransport.request === request) {
      return;
    }
    this.replaceTransport({ key, request }, 'loading');
    this.requestImmediate();
  }

  setPanelVisible(visible: boolean) {
    if (this.panelVisible === visible) return;
    this.panelVisible = visible;
    if (!this.transport || this.stoppedForProtocolError) return;
    if (visible) this.requestImmediate();
    else if (!this.inFlight) this.scheduleNext();
  }

  notifyProjectReplaced() {
    if (!this.transport || this.stoppedForProtocolError) return;
    this.generation += 1;
    this.cancelTimer();
    this.forceFull = true;
    this.getStore().clear('loading');
    this.requestImmediate();
  }

  dispose() {
    this.replaceTransport(null, 'disconnected');
  }

  private replaceTransport(
    transport: AssetProfilerTransport | null,
    status: 'disconnected' | 'unsupported' | 'loading',
  ) {
    this.generation += 1;
    this.cancelTimer();
    this.transport = transport;
    this.forceFull = true;
    this.stoppedForProtocolError = false;
    this.requestAfterFlight = false;
    this.getStore().clear(status);
  }

  private requestImmediate() {
    this.cancelTimer();
    if (this.inFlight) {
      this.requestAfterFlight = true;
      return;
    }
    this.runNow();
  }

  private runNow() {
    const transport = this.transport;
    if (!transport || this.inFlight || this.stoppedForProtocolError) return;
    this.cancelTimer();
    const generation = this.generation;
    const store = this.getStore();
    const cursor =
      !this.forceFull && store.payload
        ? {
            sessionId: store.payload.sessionId,
            afterSequence: store.payload.latestSequence,
          }
        : undefined;
    this.inFlight = true;
    this.requestAfterFlight = false;
    void transport
      .request(cursor)
      .then((payload) => {
        if (generation !== this.generation || transport !== this.transport) return;
        this.handleApplyResult(this.getStore().applyPayload(payload));
      })
      .catch((error: unknown) => {
        if (generation !== this.generation || transport !== this.transport) return;
        const code = errorCode(error);
        if (code === 'assets.editor_profiler_session_mismatch') {
          this.forceFull = true;
          this.getStore().setStatus('loading');
          this.requestAfterFlight = true;
          return;
        }
        this.getStore().setStatus('error', errorMessage(error));
        if (isTerminalProtocolError(code)) this.stoppedForProtocolError = true;
      })
      .finally(() => {
        this.inFlight = false;
        if (!this.transport || this.stoppedForProtocolError) return;
        if (this.requestAfterFlight) {
          this.requestAfterFlight = false;
          this.runNow();
        } else {
          this.scheduleNext();
        }
      });
  }

  private handleApplyResult(result: AssetProfilerApplyResult) {
    if (result === 'accepted') {
      this.forceFull = false;
      return;
    }
    if (result === 'history-gap' || result === 'session-mismatch' || result === 'cursor-mismatch') {
      this.forceFull = true;
      this.requestAfterFlight = true;
    }
  }

  private scheduleNext() {
    this.cancelTimer();
    if (!this.transport || this.stoppedForProtocolError) return;
    this.timer = this.scheduler.setTimeout(
      () => {
        this.timer = null;
        this.runNow();
      },
      this.panelVisible ? 500 : 1000,
    );
  }

  private cancelTimer() {
    if (this.timer === null) return;
    this.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }
}
