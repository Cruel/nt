import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vite-plus/test';

const playerBootstrap = readFileSync(path.resolve('../web/player_pre.js'), 'utf8');

async function runLicensePreload(
  options: {
    absent?: boolean;
    tampered?: boolean;
    corruptMounted?: boolean;
    failWrite?: boolean;
  } = {},
) {
  const notice = 'MIT License\nCopyright 2026 Example\n';
  const hash = createHash('sha256').update(notice).digest('hex');
  const index = JSON.stringify({
    format: 'noveltea.engine-licenses',
    components: [
      {
        component: 'example',
        displayName: 'Example',
        version: '1',
        files: [{ path: 'licenses/example--license.txt', size: notice.length, sha256: hash }],
      },
    ],
  });
  const staged = new Map<string, Uint8Array>();
  const requested: string[] = [];
  const warnings: string[] = [];
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const source = (url: string) => {
    const pathname = new URL(url).pathname;
    requested.push(pathname);
    if (pathname.endsWith('/licenses/index.json') && !options.absent) return index;
    if (pathname.endsWith('/licenses/example--license.txt'))
      return options.tampered ? 'Tampered license text' : notice;
    return null;
  };
  const context = {
    Module: {
      preRun: [] as Array<() => void>,
      onNovelTeaLoadingProgress: () => {},
      novelteaLicensePreload: null as unknown,
    },
    document: { baseURI: 'https://example.test/game/index.html' },
    URL,
    TextDecoder,
    Uint8Array,
    Set,
    crypto: webcrypto,
    fetch: async (url: URL) => {
      const value = source(String(url));
      const bytes = value === null ? null : new TextEncoder().encode(value);
      return {
        ok: bytes !== null,
        status: bytes === null ? 404 : 200,
        arrayBuffer: async () => bytes?.buffer.slice(0) ?? new ArrayBuffer(0),
      };
    },
    FS: {
      mkdirTree() {},
      writeFile(file: string, bytes: Uint8Array) {
        if (options.failWrite) throw new Error('Mock Emscripten filesystem write failed');
        staged.set(file, bytes);
      },
      readFile(file: string) {
        const bytes = staged.get(file);
        if (!bytes) throw new Error('File is not mounted: ' + file);
        if (options.corruptMounted && file.endsWith('example--license.txt'))
          return new TextEncoder().encode('tampered mounted bytes');
        return bytes;
      },
    },
    addRunDependency() {},
    removeRunDependency(key: string) {
      if (key === 'noveltea-player-license-assets') resolveFinished();
    },
    NovelTeaPlayerBootstrap: { createPlayerBootstrap: () => ({ start() {} }) },
    console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')) },
  };
  vm.runInNewContext(playerBootstrap, context);
  context.Module.preRun[0]!();
  await finished;
  return {
    staged,
    requested,
    warnings,
    index,
    notice,
    status: context.Module.novelteaLicensePreload,
  };
}

describe('Web player target-license asset transport', () => {
  it('preloads the selected Web target catalog and verified notice text into system assets', async () => {
    const result = await runLicensePreload();
    expect(result.warnings).toEqual([]);
    expect(result.requested).toEqual([
      '/game/assets/system/licenses/index.json',
      '/game/assets/system/licenses/example--license.txt',
    ]);
    expect(new TextDecoder().decode(result.staged.get('/assets/system/licenses/index.json'))).toBe(
      result.index,
    );
    expect(
      new TextDecoder().decode(result.staged.get('/assets/system/licenses/example--license.txt')),
    ).toBe(result.notice);
    expect(result.status).toEqual({
      status: 'verified',
      indexSha256: createHash('sha256').update(result.index).digest('hex'),
      notices: [
        {
          path: 'licenses/example--license.txt',
          size: Buffer.byteLength(result.notice),
          sha256: createHash('sha256').update(result.notice).digest('hex'),
        },
      ],
    });
  });

  it('fails closed for absent or tampered target catalogs without substituting other targets', async () => {
    const missing = await runLicensePreload({ absent: true });
    expect(missing.staged.size).toBe(0);
    expect(missing.status).toEqual({ status: 'absent' });
    const corrupt = await runLicensePreload({ tampered: true });
    expect(corrupt.staged.size).toBe(0);
    expect(corrupt.warnings.join(' ')).toContain('target license inventory unavailable');
    expect(corrupt.status).toMatchObject({ status: 'failed' });
  });

  it('never signals success if verified downloads fail to mount or fail filesystem readback', async () => {
    for (const options of [{ failWrite: true }, { corruptMounted: true }]) {
      const result = await runLicensePreload(options);
      expect(result.requested).toHaveLength(2);
      expect(result.status).toMatchObject({ status: 'failed' });
      expect(result.warnings.join(' ')).toContain('target license inventory unavailable');
    }
  });
});
