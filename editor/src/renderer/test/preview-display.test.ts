import { describe, expect, it } from 'vite-plus/test';
import {
  effectivePreviewDisplay,
  normalizePreviewDisplayPreference,
} from '../../shared/preview-display';

describe('preview display helpers', () => {
  it('normalizes display preferences without adding preview sizing state', () => {
    const preference = normalizePreviewDisplayPreference({
      mode: 'custom',
      aspectRatio: { width: 1920, height: 1080 },
      orientation: 'portrait',
    });
    expect(preference).toMatchObject({
      mode: 'custom',
      aspectRatio: { width: 16, height: 9 },
    });
    expect(preference).not.toHaveProperty('scaling');
    expect(
      effectivePreviewDisplay(preference, {
        referenceResolution: { width: 1080, height: 1920 },
        worldRasterPolicy: 'capped',
        barColor: '#123456',
      }),
    ).toMatchObject({
      orientation: 'portrait',
      barColor: '#123456',
    });
  });
});
