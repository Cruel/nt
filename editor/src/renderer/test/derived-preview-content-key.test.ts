import { describe, expect, it } from 'vite-plus/test';
import { focusedPreviewTarget, legacyPreviewContentKey } from '@/preview/DerivedPreviewPane';
import type { PreviewDocument } from '../../shared/preview-protocol';

function dialoguePreview(data: Record<string, unknown>): PreviewDocument {
  return {
    kind: 'dialogue-preview',
    recordId: 'dialogue-a',
    revision: 'unchanged-content-revision',
    data,
  };
}

describe('focusedPreviewTarget', () => {
  it('matches the diagnostic collection when clearing successful Room, Layout and Shader previews', () => {
    expect(focusedPreviewTarget({ kind: 'room-preview', recordId: 'room-a' })).toEqual({
      collection: 'rooms',
      entityId: 'room-a',
      kind: 'room',
    });
    expect(focusedPreviewTarget({ kind: 'layout-preview', recordId: 'layout-a' })).toEqual({
      collection: 'layouts',
      entityId: 'layout-a',
      kind: 'layout',
    });
    expect(focusedPreviewTarget({ kind: 'shader-preview', recordId: 'shader-a' })).toEqual({
      collection: 'shaders',
      entityId: 'shader-a',
      kind: 'shader',
    });
  });
});

describe('legacyPreviewContentKey', () => {
  it('changes when preview-only payload state changes without a content revision', () => {
    const first = legacyPreviewContentKey(
      'project-one',
      'dialogue',
      dialoguePreview({ selectedBlockId: 'start', showConditions: false }),
      undefined,
    );
    const second = legacyPreviewContentKey(
      'project-one',
      'dialogue',
      dialoguePreview({ selectedBlockId: 'branch', showConditions: true }),
      undefined,
    );

    expect(second).not.toBe(first);
  });

  it('changes when an otherwise identical tab is restored for another project instance', () => {
    const document = dialoguePreview({ selectedBlockId: 'start' });

    expect(legacyPreviewContentKey('project-two', 'dialogue', document, undefined)).not.toBe(
      legacyPreviewContentKey('project-one', 'dialogue', document, undefined),
    );
  });
});
