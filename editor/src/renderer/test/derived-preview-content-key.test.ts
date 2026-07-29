import { describe, expect, it } from 'vite-plus/test';
import { legacyPreviewContentKey } from '@/preview/DerivedPreviewPane';
import type { PreviewDocument } from '../../shared/preview-protocol';

function dialoguePreview(data: Record<string, unknown>): PreviewDocument {
  return {
    kind: 'dialogue-preview',
    recordId: 'dialogue-a',
    revision: 'unchanged-content-revision',
    data,
  };
}

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
