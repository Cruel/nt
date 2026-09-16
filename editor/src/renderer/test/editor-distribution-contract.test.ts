import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  novelTeaDevelopmentVersion,
  readNovelTeaBuildIdentity,
} from '../../../../scripts/noveltea-version.mjs';
// @ts-expect-error The distribution helper is intentionally authored as a Node ESM script.
import * as editorDistribution from '../../../scripts/editor-distribution-lib.mjs';
const { assertCurrentEditorStageManifest } = editorDistribution;

describe('editor distribution stage manifest', () => {
  it('derives local build versions from the canonical product version', () => {
    expect(novelTeaDevelopmentVersion('1.0.0', '0123456789abcdef')).toBe('1.0.0-dev.0123456789ab');
    expect(novelTeaDevelopmentVersion('1.1.0-rc.1', 'abcdef0123456789')).toBe(
      '1.1.0-rc.1.dev.abcdef012345',
    );
  });

  it('keeps development build identity stable when the checkout contains an untracked nested repository', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'noveltea-build-identity-'));
    const previousOverride = process.env.NOVELTEA_BUILD_IDENTITY;
    delete process.env.NOVELTEA_BUILD_IDENTITY;
    try {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'NovelTea Test'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'noveltea@example.invalid'], { cwd: root });
      writeFileSync(path.join(root, 'tracked.txt'), 'tracked\n');
      execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
      execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });

      const nested = path.join(root, 'nested-worktree');
      mkdirSync(nested);
      execFileSync('git', ['init'], { cwd: nested, stdio: 'ignore' });
      writeFileSync(path.join(nested, 'local.txt'), 'outside parent repository identity\n');

      const first = readNovelTeaBuildIdentity(root);
      const second = readNovelTeaBuildIdentity(root);
      expect(first).toBe(second);
      expect(first).toMatch(/^git:[0-9a-f]+$/u);
    } finally {
      if (previousOverride === undefined) delete process.env.NOVELTEA_BUILD_IDENTITY;
      else process.env.NOVELTEA_BUILD_IDENTITY = previousOverride;
      rmSync(root, { recursive: true, force: true });
    }
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
