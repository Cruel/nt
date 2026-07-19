import { create } from 'zustand';
import type {
  EnginePreviewSession,
  PreviewConnectionState,
  PreviewPosition,
} from '../../shared/preview-protocol';
import {
  DEFAULT_ENTITY_PREVIEW_POOL_SIZE,
  PRIMARY_PREVIEW_SESSION_ID,
  THUMBNAIL_WORKER_SESSION_ID,
  chooseEntityPreviewAdmission,
  createDiagnosticId,
  createEntityPreviewSession,
  createPrimaryRuntimeSession,
  createThumbnailCacheKey,
  createThumbnailRequestId,
  createThumbnailWorkerSession,
} from './preview-manager';
import type {
  EntityPreviewRequest,
  PreviewDiagnosticRecord,
  PreviewDiagnosticSeverity,
  PreviewDiagnosticSource,
  PreviewDocument,
  PreviewMode,
  PreviewReplayState,
  PreviewSessionKind,
  PreviewSessionRecord,
  PreviewSessionStatus,
  PreviewTarget,
  ThumbnailRequest,
  ThumbnailRequestInput,
  ThumbnailStatus,
} from './preview-types';

interface RecordDiagnosticOptions {
  sessionId?: string;
  target?: PreviewTarget;
  severity: PreviewDiagnosticSeverity;
  source: PreviewDiagnosticSource;
  message: string;
  path?: string;
  timestamp?: number;
}

interface PreviewManagerState {
  sessionsById: Record<string, PreviewSessionRecord>;
  diagnosticsById: Record<string, PreviewDiagnosticRecord>;
  diagnosticOrder: string[];
  replay: PreviewReplayState;
  thumbnailRequestsByKey: Record<string, ThumbnailRequest>;
  entityPoolSize: number;
  ensurePrimaryRuntimeSession: (now?: number) => PreviewSessionRecord;
  ensureThumbnailWorkerSession: (now?: number) => PreviewSessionRecord;
  setSessionStatus: (sessionId: string, status: PreviewSessionStatus, now?: number) => void;
  setSessionCapabilities: (sessionId: string, capabilities: string[]) => void;
  setPrimaryTransport: (session: EnginePreviewSession | null) => void;
  setPrimaryRuntimeReplay: (state: { position: PreviewPosition }) => void;
  setPreviewDocumentReplay: (
    sessionId: string,
    document: PreviewDocument,
    mode?: PreviewMode,
  ) => void;
  requestEntityPreview: (
    request: EntityPreviewRequest,
  ) => { ok: true; session: PreviewSessionRecord } | { ok: false; error: string };
  releasePreviewOwner: (ownerId: string, now?: number) => void;
  recordPreviewDiagnostic: (options: RecordDiagnosticOptions) => PreviewDiagnosticRecord;
  clearPreviewDiagnostics: () => void;
  requestThumbnail: (input: ThumbnailRequestInput) => ThumbnailRequest;
  setThumbnailStatus: (
    cacheKey: string,
    status: ThumbnailStatus,
    options?: { dataUrl?: string; error?: string; now?: number },
  ) => void;
  invalidateThumbnailsForTarget: (target: PreviewTarget) => void;
  clearThumbnailCache: () => void;
  resetPreviewManager: () => void;
}

function nowOr(value: number | undefined): number {
  return value ?? Date.now();
}

function initialReplay(): PreviewReplayState {
  return {
    primaryRuntime: { position: { x: 0.5, y: 0.5 } },
    documentsBySessionId: {},
    modeBySessionId: {},
  };
}

function attachDiagnosticId(
  session: PreviewSessionRecord,
  diagnosticId: string,
): PreviewSessionRecord {
  return {
    ...session,
    diagnosticIds: session.diagnosticIds.includes(diagnosticId)
      ? session.diagnosticIds
      : [...session.diagnosticIds, diagnosticId],
  };
}

export const usePreviewManagerStore = create<PreviewManagerState>()((set, get) => ({
  sessionsById: {},
  diagnosticsById: {},
  diagnosticOrder: [],
  replay: initialReplay(),
  thumbnailRequestsByKey: {},
  entityPoolSize: DEFAULT_ENTITY_PREVIEW_POOL_SIZE,

  ensurePrimaryRuntimeSession: (timestamp) => {
    const now = nowOr(timestamp);
    const existing = get().sessionsById[PRIMARY_PREVIEW_SESSION_ID];
    if (existing && existing.status !== 'disposed') return existing;
    const session = createPrimaryRuntimeSession(now);
    set((state) => ({ sessionsById: { ...state.sessionsById, [session.id]: session } }));
    return session;
  },

  ensureThumbnailWorkerSession: (timestamp) => {
    const now = nowOr(timestamp);
    const existing = get().sessionsById[THUMBNAIL_WORKER_SESSION_ID];
    if (existing && existing.status !== 'disposed') return existing;
    const session = createThumbnailWorkerSession(now);
    set((state) => ({ sessionsById: { ...state.sessionsById, [session.id]: session } }));
    return session;
  },

  setSessionStatus: (sessionId, status, timestamp) => {
    const now = nowOr(timestamp);
    set((state) => {
      const session = state.sessionsById[sessionId];
      if (!session) return state;
      return {
        sessionsById: {
          ...state.sessionsById,
          [sessionId]: { ...session, status, lastUsedAt: now },
        },
      };
    });
  },

  setSessionCapabilities: (sessionId, capabilities) => {
    set((state) => {
      const session = state.sessionsById[sessionId];
      if (!session) return state;
      return {
        sessionsById: {
          ...state.sessionsById,
          [sessionId]: { ...session, capabilities: [...capabilities] },
        },
      };
    });
  },

  setPrimaryTransport: (session) => {
    const primary = get().ensurePrimaryRuntimeSession();
    set((state) => {
      const current = state.sessionsById[primary.id]!;
      return {
        sessionsById: {
          ...state.sessionsById,
          [primary.id]: {
            ...current,
            transport: session ? { url: session.url, origin: session.origin } : undefined,
          },
        },
      };
    });
  },

  setPrimaryRuntimeReplay: (primaryRuntime) => {
    set((state) => ({ replay: { ...state.replay, primaryRuntime } }));
  },

  setPreviewDocumentReplay: (sessionId, document, mode) => {
    set((state) => ({
      replay: {
        ...state.replay,
        documentsBySessionId: { ...state.replay.documentsBySessionId, [sessionId]: document },
        modeBySessionId: mode
          ? { ...state.replay.modeBySessionId, [sessionId]: mode }
          : state.replay.modeBySessionId,
      },
    }));
  },

  requestEntityPreview: (request) => {
    const now = nowOr(request.now);
    const admission = chooseEntityPreviewAdmission(
      get().sessionsById,
      request,
      get().entityPoolSize,
    );
    if (admission.type === 'reject') {
      get().recordPreviewDiagnostic({
        severity: 'warning',
        source: 'manager',
        message: admission.reason,
        target: request.target,
        timestamp: now,
      });
      return { ok: false, error: admission.reason };
    }

    if (admission.type === 'reuse') {
      set((state) => {
        const session = state.sessionsById[admission.sessionId]!;
        return {
          sessionsById: {
            ...state.sessionsById,
            [session.id]: { ...session, active: true, target: request.target, lastUsedAt: now },
          },
        };
      });
      if (request.document)
        get().setPreviewDocumentReplay(admission.sessionId, request.document, request.mode);
      return { ok: true, session: get().sessionsById[admission.sessionId]! };
    }

    const nextSessions = { ...get().sessionsById };
    if (admission.type === 'evict') {
      nextSessions[admission.evictSessionId] = {
        ...nextSessions[admission.evictSessionId]!,
        active: false,
        status: 'disposed',
        lastUsedAt: now,
      };
    }
    const session = createEntityPreviewSession(request, admission.sessionId, now);
    nextSessions[session.id] = session;
    set({ sessionsById: nextSessions });
    if (request.document)
      get().setPreviewDocumentReplay(session.id, request.document, request.mode);
    return { ok: true, session };
  },

  releasePreviewOwner: (ownerId, timestamp) => {
    const now = nowOr(timestamp);
    set((state) => ({
      sessionsById: Object.fromEntries(
        Object.entries(state.sessionsById).map(([sessionId, session]) => [
          sessionId,
          session.ownerId === ownerId && session.kind !== 'primary-runtime'
            ? {
                ...session,
                active: false,
                status: session.status === 'disposed' ? 'disposed' : 'idle',
                lastUsedAt: now,
              }
            : session,
        ]),
      ),
    }));
  },

  recordPreviewDiagnostic: (options) => {
    const timestamp = nowOr(options.timestamp);
    const id = createDiagnosticId(timestamp, get().diagnosticOrder.length);
    const diagnostic: PreviewDiagnosticRecord = { ...options, id, timestamp };
    set((state) => {
      const session = options.sessionId ? state.sessionsById[options.sessionId] : undefined;
      return {
        diagnosticsById: { ...state.diagnosticsById, [id]: diagnostic },
        diagnosticOrder: [id, ...state.diagnosticOrder].slice(0, 200),
        sessionsById: session
          ? { ...state.sessionsById, [session.id]: attachDiagnosticId(session, id) }
          : state.sessionsById,
      };
    });
    return diagnostic;
  },

  clearPreviewDiagnostics: () => set({ diagnosticsById: {}, diagnosticOrder: [] }),

  requestThumbnail: (input) => {
    get().ensureThumbnailWorkerSession(input.now);
    const now = nowOr(input.now);
    const cacheKey = createThumbnailCacheKey(input);
    const existing = get().thumbnailRequestsByKey[cacheKey];
    if (existing) return existing;
    const request: ThumbnailRequest = {
      id: createThumbnailRequestId(cacheKey),
      target: input.target,
      cacheKey,
      document: input.document,
      status: 'queued',
      requestedAt: now,
      updatedAt: now,
    };
    set((state) => ({
      thumbnailRequestsByKey: { ...state.thumbnailRequestsByKey, [cacheKey]: request },
    }));
    return request;
  },

  setThumbnailStatus: (cacheKey, status, options = {}) => {
    const now = nowOr(options.now);
    set((state) => {
      const request = state.thumbnailRequestsByKey[cacheKey];
      if (!request) return state;
      return {
        thumbnailRequestsByKey: {
          ...state.thumbnailRequestsByKey,
          [cacheKey]: {
            ...request,
            status,
            dataUrl: options.dataUrl ?? request.dataUrl,
            error: options.error,
            updatedAt: now,
          },
        },
      };
    });
  },

  invalidateThumbnailsForTarget: (target) => {
    const prefix = `${target.collection ?? ''}:${target.entityId ?? ''}:${target.kind ?? ''}:${target.label ?? ''}`;
    set((state) => ({
      thumbnailRequestsByKey: Object.fromEntries(
        Object.entries(state.thumbnailRequestsByKey).filter(
          ([cacheKey]) => !cacheKey.startsWith(prefix),
        ),
      ),
    }));
  },

  clearThumbnailCache: () => set({ thumbnailRequestsByKey: {} }),

  resetPreviewManager: () =>
    set({
      sessionsById: {},
      diagnosticsById: {},
      diagnosticOrder: [],
      replay: initialReplay(),
      thumbnailRequestsByKey: {},
      entityPoolSize: DEFAULT_ENTITY_PREVIEW_POOL_SIZE,
    }),
}));

export function previewSessionByKind(kind: PreviewSessionKind): PreviewSessionRecord[] {
  return Object.values(usePreviewManagerStore.getState().sessionsById).filter(
    (session) => session.kind === kind,
  );
}

export function mapConnectionStateToSessionStatus(
  state: PreviewConnectionState,
): PreviewSessionStatus {
  return state;
}
