import { describe, expect, it } from 'vite-plus/test';
import {
  authoredPreviewEnvironment,
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
      name: 'custom-16x9-portrait',
      nativeResolution: { width: 1080, height: 1920 },
      orientation: 'portrait',
      barColor: '#123456',
    });
  });

  it('combines the selected native profile with the authored Layout scale policy', () => {
    const profile = effectivePreviewDisplay(
      { mode: 'project' },
      {
        referenceResolution: { width: 2560, height: 1440 },
        worldRasterPolicy: 'native',
        barColor: '#112233',
      },
    );
    expect(
      authoredPreviewEnvironment(
        {
          kind: 'layout-preview',
          recordId: 'hud',
          revision: '1',
          data: { scalePolicy: { ui: 'ignore', text: 'inherit' } },
        },
        profile,
        {
          referenceResolution: { width: 2560, height: 1440 },
          worldRasterPolicy: 'native',
          barColor: '#112233',
        },
      ),
    ).toEqual({
      profile: {
        name: 'project',
        nativeResolution: { width: 2560, height: 1440 },
        scalePolicy: { ui: 'ignore', text: 'inherit' },
      },
      project: {
        referenceResolution: { width: 2560, height: 1440 },
        worldRasterPolicy: 'native',
        barColor: '#112233',
        accessibility: {
          uiScale: { enabled: true, minimum: 1, maximum: 2 },
          textScale: { enabled: true, minimum: 1, maximum: 2 },
        },
      },
    });
  });

  it('does not construct an authored environment without a resolved Layout scale policy', () => {
    expect(
      authoredPreviewEnvironment(
        {
          kind: 'layout-preview',
          recordId: 'invalid-layout',
          revision: '1',
          data: {},
        },
        effectivePreviewDisplay({ mode: 'project' }),
      ),
    ).toBeUndefined();
  });
});
