import { describe, expect, it } from 'vite-plus/test';
// @ts-expect-error The distribution helper is intentionally authored as a Node ESM script.
import { assertCurrentEditorStageManifest } from '../../../scripts/editor-distribution-lib.mjs';

describe('editor distribution stage manifest', () => {
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
