import { beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  DEFAULT_ENTITY_PREVIEW_POOL_SIZE,
  PRIMARY_PREVIEW_SESSION_ID,
  chooseEntityPreviewAdmission,
  createEntityPreviewSession,
  createThumbnailCacheKey,
} from '@/preview/preview-manager';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import type {
  EntityPreviewRequest,
  PreviewDocument,
  ThumbnailRequestInput,
} from '@/preview/preview-types';

function request(ownerId: string, now = 1): EntityPreviewRequest {
  return { ownerId, target: { collection: 'materials', entityId: ownerId }, now };
}

const symbolicDocument: PreviewDocument = {
  kind: 'symbolic',
  target: { collection: 'materials', entityId: 'mat-a' },
  label: 'Material A',
  revision: 'rev-a',
};

beforeEach(() => {
  usePreviewManagerStore.getState().resetPreviewManager();
});

describe('preview manager policy', () => {
  it('admits entity previews up to the configured pool size', () => {
    const sessions = {};
    expect(
      chooseEntityPreviewAdmission(sessions, request('tab-a'), DEFAULT_ENTITY_PREVIEW_POOL_SIZE),
    ).toEqual({
      type: 'create',
      sessionId: 'preview-session:entity:tab-a',
    });
  });

  it('reuses sessions for the same owner', () => {
    const session = createEntityPreviewSession(request('tab-a'), 'preview-session:entity:tab-a', 1);
    expect(chooseEntityPreviewAdmission({ [session.id]: session }, request('tab-a', 2))).toEqual({
      type: 'reuse',
      sessionId: session.id,
    });
  });

  it('evicts the least-recently-used idle entity session', () => {
    const left = {
      ...createEntityPreviewSession(request('tab-a'), 'preview-session:entity:tab-a', 1),
      active: false,
      lastUsedAt: 10,
    };
    const right = {
      ...createEntityPreviewSession(request('tab-b'), 'preview-session:entity:tab-b', 2),
      active: false,
      lastUsedAt: 20,
    };
    expect(
      chooseEntityPreviewAdmission({ [left.id]: left, [right.id]: right }, request('tab-c', 30), 2),
    ).toEqual({
      type: 'evict',
      evictSessionId: left.id,
      sessionId: 'preview-session:entity:tab-c',
    });
  });

  it('rejects when all entity sessions are active', () => {
    const left = createEntityPreviewSession(request('tab-a'), 'preview-session:entity:tab-a', 1);
    const right = createEntityPreviewSession(request('tab-b'), 'preview-session:entity:tab-b', 2);
    expect(
      chooseEntityPreviewAdmission({ [left.id]: left, [right.id]: right }, request('tab-c', 30), 2),
    ).toMatchObject({
      type: 'reject',
    });
  });
});

describe('preview manager store', () => {
  it('creates and reuses the primary runtime session', () => {
    const first = usePreviewManagerStore.getState().ensurePrimaryRuntimeSession(1);
    const second = usePreviewManagerStore.getState().ensurePrimaryRuntimeSession(2);
    expect(first.id).toBe(PRIMARY_PREVIEW_SESSION_ID);
    expect(second.id).toBe(first.id);
    expect(Object.values(usePreviewManagerStore.getState().sessionsById)).toHaveLength(1);
  });

  it('records bounded entity preview requests and replay documents', () => {
    const result = usePreviewManagerStore.getState().requestEntityPreview({
      ownerId: 'tab-a',
      target: { collection: 'materials', entityId: 'mat-a' },
      document: symbolicDocument,
      mode: 'symbolic',
      now: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.kind).toBe('entity');
    expect(
      usePreviewManagerStore.getState().replay.documentsBySessionId[result.session.id],
    ).toEqual(symbolicDocument);
    expect(usePreviewManagerStore.getState().replay.modeBySessionId[result.session.id]).toBe(
      'symbolic',
    );
  });

  it('releases owners and reuses idle capacity', () => {
    expect(usePreviewManagerStore.getState().requestEntityPreview(request('tab-a', 1)).ok).toBe(
      true,
    );
    expect(usePreviewManagerStore.getState().requestEntityPreview(request('tab-b', 2)).ok).toBe(
      true,
    );
    usePreviewManagerStore.getState().releasePreviewOwner('tab-a', 3);
    const result = usePreviewManagerStore.getState().requestEntityPreview(request('tab-c', 4));
    expect(result.ok).toBe(true);
    expect(
      usePreviewManagerStore.getState().sessionsById['preview-session:entity:tab-a']?.status,
    ).toBe('disposed');
  });

  it('diagnoses entity preview pool capacity errors', () => {
    expect(usePreviewManagerStore.getState().requestEntityPreview(request('tab-a', 1)).ok).toBe(
      true,
    );
    expect(usePreviewManagerStore.getState().requestEntityPreview(request('tab-b', 2)).ok).toBe(
      true,
    );
    const result = usePreviewManagerStore.getState().requestEntityPreview(request('tab-c', 3));
    expect(result.ok).toBe(false);
    const diagnostics = usePreviewManagerStore
      .getState()
      .diagnosticOrder.map((id) => usePreviewManagerStore.getState().diagnosticsById[id]);
    expect(diagnostics[0]?.message).toContain('Entity preview pool is full');
  });

  it('dedupes and invalidates thumbnail cache entries', () => {
    const input: ThumbnailRequestInput = {
      target: { collection: 'materials', entityId: 'mat-a' },
      document: symbolicDocument,
      revision: 'rev-a',
      now: 1,
    };
    const first = usePreviewManagerStore.getState().requestThumbnail(input);
    const second = usePreviewManagerStore.getState().requestThumbnail({ ...input, now: 2 });
    expect(second).toBe(first);
    usePreviewManagerStore.getState().setThumbnailStatus(first.cacheKey, 'ready', {
      dataUrl: 'data:image/png;base64,test',
      now: 3,
    });
    expect(usePreviewManagerStore.getState().thumbnailRequestsByKey[first.cacheKey]?.status).toBe(
      'ready',
    );
    expect(createThumbnailCacheKey(input)).toBe(first.cacheKey);
    usePreviewManagerStore
      .getState()
      .invalidateThumbnailsForTarget({ collection: 'materials', entityId: 'mat-a' });
    expect(
      usePreviewManagerStore.getState().thumbnailRequestsByKey[first.cacheKey],
    ).toBeUndefined();
  });
});
