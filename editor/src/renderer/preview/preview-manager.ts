import type {
  EntityPreviewRequest,
  PreviewSessionRecord,
  PreviewTarget,
  ThumbnailRequestInput,
} from './preview-types';

export const PRIMARY_PREVIEW_SESSION_ID = 'preview-session:primary-runtime';
export const PRIMARY_PREVIEW_OWNER_ID = 'preview:primary';
export const THUMBNAIL_WORKER_SESSION_ID = 'preview-session:thumbnail-worker';
export const DEFAULT_ENTITY_PREVIEW_POOL_SIZE = 2;

export type EntityPreviewAdmission =
  | { type: 'reuse'; sessionId: string }
  | { type: 'create'; sessionId: string }
  | { type: 'evict'; evictSessionId: string; sessionId: string }
  | { type: 'reject'; reason: string };

export function createEntityPreviewSessionId(ownerId: string): string {
  return `preview-session:entity:${encodeURIComponent(ownerId)}`;
}

export function createDiagnosticId(timestamp: number, index: number): string {
  return `preview-diagnostic:${timestamp}:${index}`;
}

export function createThumbnailRequestId(cacheKey: string): string {
  return `thumbnail:${cacheKey}`;
}

export function previewTargetKey(target: PreviewTarget): string {
  return [
    target.collection ?? '',
    target.entityId ?? '',
    target.kind ?? '',
    target.label ?? '',
  ].join(':');
}

export function previewTargetLabel(target?: PreviewTarget): string {
  if (!target) return 'preview';
  if (target.collection && target.entityId) return `${target.collection}/${target.entityId}`;
  return target.label ?? target.kind ?? 'preview';
}

export function createThumbnailCacheKey(input: ThumbnailRequestInput): string {
  return `${previewTargetKey(input.target)}:${input.document.kind}:${input.revision}`;
}

export function chooseEntityPreviewAdmission(
  sessions: Record<string, PreviewSessionRecord>,
  request: EntityPreviewRequest,
  poolSize = DEFAULT_ENTITY_PREVIEW_POOL_SIZE,
): EntityPreviewAdmission {
  const existing = Object.values(sessions).find(
    (session) =>
      session.kind === 'entity' &&
      session.ownerId === request.ownerId &&
      session.status !== 'disposed',
  );
  if (existing) return { type: 'reuse', sessionId: existing.id };

  const entitySessions = Object.values(sessions).filter(
    (session) => session.kind === 'entity' && session.status !== 'disposed',
  );
  const inactive = entitySessions
    .filter((session) => !session.active)
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);

  if (entitySessions.length < poolSize) {
    return { type: 'create', sessionId: createEntityPreviewSessionId(request.ownerId) };
  }

  const evictable = inactive[0];
  if (evictable) {
    return {
      type: 'evict',
      evictSessionId: evictable.id,
      sessionId: createEntityPreviewSessionId(request.ownerId),
    };
  }

  return { type: 'reject', reason: `Entity preview pool is full (${poolSize}/${poolSize}).` };
}

export function createPrimaryRuntimeSession(now: number): PreviewSessionRecord {
  return {
    id: PRIMARY_PREVIEW_SESSION_ID,
    kind: 'primary-runtime',
    ownerId: PRIMARY_PREVIEW_OWNER_ID,
    status: 'idle',
    capabilities: [],
    active: true,
    createdAt: now,
    lastUsedAt: now,
    diagnosticIds: [],
  };
}

export function createThumbnailWorkerSession(now: number): PreviewSessionRecord {
  return {
    id: THUMBNAIL_WORKER_SESSION_ID,
    kind: 'thumbnail-worker',
    ownerId: 'preview:thumbnail-worker',
    status: 'idle',
    capabilities: [],
    active: false,
    createdAt: now,
    lastUsedAt: now,
    diagnosticIds: [],
  };
}

export function createEntityPreviewSession(
  request: EntityPreviewRequest,
  sessionId: string,
  now: number,
): PreviewSessionRecord {
  return {
    id: sessionId,
    kind: 'entity',
    ownerId: request.ownerId,
    target: request.target,
    status: 'idle',
    capabilities: [],
    active: true,
    createdAt: now,
    lastUsedAt: now,
    diagnosticIds: [],
  };
}
