import { describe, expect, it } from 'vite-plus/test';
import {
  normalizeEditorPreviewLayoutPreference,
  resolveEditorPreviewSplitOrientation,
} from '@/components/editor-preview-layout';
import { DEFAULT_PROJECT_DISPLAY_SETTINGS } from '../../shared/project-schema/authoring-project-settings';

describe('editor preview layout', () => {
  it('uses vertical stacking for landscape projects and side-by-side for portrait projects', () => {
    expect(
      resolveEditorPreviewSplitOrientation('automatic', DEFAULT_PROJECT_DISPLAY_SETTINGS),
    ).toBe('vertical');
    expect(
      resolveEditorPreviewSplitOrientation('automatic', {
        ...DEFAULT_PROJECT_DISPLAY_SETTINGS,
        referenceResolution: { width: 1080, height: 1920 },
      }),
    ).toBe('horizontal');
  });

  it('honors explicit overrides and normalizes unsupported persisted values', () => {
    expect(
      resolveEditorPreviewSplitOrientation('horizontal', DEFAULT_PROJECT_DISPLAY_SETTINGS),
    ).toBe('horizontal');
    expect(resolveEditorPreviewSplitOrientation('vertical', DEFAULT_PROJECT_DISPLAY_SETTINGS)).toBe(
      'vertical',
    );
    expect(normalizeEditorPreviewLayoutPreference('unsupported')).toBe('automatic');
  });
});
