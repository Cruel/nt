import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const { invokeNovelTeaNativeOperation } = vi.hoisted(() => ({
  invokeNovelTeaNativeOperation: vi.fn(),
}));
vi.mock('../../shared/noveltea-cli-subprocess', () => ({
  invokeNovelTeaNativeOperation,
  resolveNovelTeaCliPath: vi.fn(),
}));

import { compileShaders } from '../../main/services/editor-tool-service';

const temporaryRoots: string[] = [];
afterEach(async () => {
  invokeNovelTeaNativeOperation.mockReset();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('shader source overlay compilation', () => {
  it('compiles against a temporary Project root with dirty entrypoints and includes overlaid', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'noveltea-overlay-test-'));
    temporaryRoots.push(projectRoot);
    await mkdir(path.join(projectRoot, 'shaders', 'common'), { recursive: true });
    await writeFile(path.join(projectRoot, 'shaders', 'panel.sc'), 'saved entrypoint', 'utf8');
    await writeFile(
      path.join(projectRoot, 'shaders', 'common', 'color.sh'),
      'saved include',
      'utf8',
    );
    let compileRoot = '';
    invokeNovelTeaNativeOperation.mockImplementationOnce(async (_operation, request) => {
      const options = (request as { options: { projectRoot: string; sourceOverlays?: unknown } })
        .options;
      compileRoot = options.projectRoot;
      expect(compileRoot).not.toBe(projectRoot);
      expect(options.sourceOverlays).toBeUndefined();
      await expect(readFile(path.join(compileRoot, 'shaders', 'panel.sc'), 'utf8')).resolves.toBe(
        'dirty entrypoint',
      );
      await expect(
        readFile(path.join(compileRoot, 'shaders', 'common', 'color.sh'), 'utf8'),
      ).resolves.toBe('dirty include');
      return { ok: true, success: true, diagnostics: [], outputs: [] };
    });

    await compileShaders(
      { schema: 'noveltea.shader-source-programs', programs: {} },
      {
        projectRoot,
        sourceOverlays: {
          'shaders/panel.sc': 'dirty entrypoint',
          'shaders/common/color.sh': 'dirty include',
        },
      },
    );

    await expect(stat(compileRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(projectRoot, 'shaders', 'panel.sc'), 'utf8')).resolves.toBe(
      'saved entrypoint',
    );
  });
});
