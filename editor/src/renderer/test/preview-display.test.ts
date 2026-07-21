import { describe, expect, it } from 'vite-plus/test';
import {
  effectivePreviewDisplay,
  fitPreviewRect,
  normalizePreviewDisplayPreference,
  referencePreviewSize,
} from '../../shared/preview-display';

describe('preview display helpers', () => {
  it('fits centered landscape and portrait rectangles deterministically', () => {
    expect(
      fitPreviewRect(1000, 800, {
        aspectRatio: { width: 16, height: 9 },
        orientation: 'landscape',
        barColor: '#000000',
      }),
    ).toEqual({ x: 0, y: 119, width: 1000, height: 562 });
    expect(
      fitPreviewRect(1000, 800, {
        aspectRatio: { width: 16, height: 9 },
        orientation: 'portrait',
        barColor: '#000000',
      }),
    ).toEqual({ x: 275, y: 0, width: 450, height: 800 });
  });

  it('derives stable reference sizes and normalizes persisted preferences', () => {
    const profile = {
      aspectRatio: { width: 16, height: 9 },
      orientation: 'portrait' as const,
      barColor: '#123456',
    };
    expect(referencePreviewSize(profile, 1280)).toEqual({ width: 720, height: 1280 });
    const preference = normalizePreviewDisplayPreference({
      mode: 'custom',
      aspectRatio: { width: 1920, height: 1080 },
      orientation: 'portrait',
      scaling: { play: 'reference', pooled: 'responsive', referenceLongAxis: 9000 },
    });
    expect(preference).toMatchObject({
      mode: 'custom',
      aspectRatio: { width: 16, height: 9 },
      scaling: { referenceLongAxis: 4096 },
    });
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
