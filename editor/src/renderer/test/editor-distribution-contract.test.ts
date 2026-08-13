import { describe, expect, it } from 'vite-plus/test';
import { novelTeaDevelopmentVersion } from '../../../../scripts/noveltea-version.mjs';
// @ts-expect-error The distribution helper is intentionally authored as a Node ESM script.
import { assertCurrentEditorStageManifest } from '../../../scripts/editor-distribution-lib.mjs';

describe('editor distribution stage manifest', () => {
  it('derives local build versions from the canonical product version', () => {
    expect(novelTeaDevelopmentVersion('1.0.0', '0123456789abcdef')).toBe('1.0.0-dev.0123456789ab');
    expect(novelTeaDevelopmentVersion('1.1.0-rc.1', 'abcdef0123456789')).toBe(
      '1.1.0-rc.1.dev.abcdef012345',
    );
  });

  it('accepts only the exact current manifest identity and version', () => {
    expect(
      assertCurrentEditorStageManifest({
        schema: 'noveltea.editor-stage-manifest',
        schemaVersion: 1,
        files: [],
      }),
    ).toMatchObject({ schemaVersion: 1, files: [] });

    expect(() => assertCurrentEditorStageManifest({ schemaVersion: 1, files: [] })).toThrow(
      'Unsupported stage manifest',
    );
    expect(() =>
      assertCurrentEditorStageManifest({
        schema: 'noveltea.editor-stage-manifest',
        schemaVersion: 2,
        files: [],
      }),
    ).toThrow('Unsupported stage manifest');
  });
});
