import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  discoverRepairModels,
  listClaudeSdkModels,
  listCodexAppServerModels,
  listOpenCodeModels,
} from '../../main/services/repair-model-catalog-service';

function withTools(
  run: (install: (name: string, contents: string) => string, root: string) => Promise<void>,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-repair-models-'));
  const install = (name: string, contents: string) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, `#!${process.execPath}\n${contents}\n`, { mode: 0o755 });
    return file;
  };
  return run(install, root).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

describe('native-host repair model discovery', () => {
  it.skipIf(process.platform === 'win32')(
    'uses actual OpenCode model IDs, never a built-in catalog',
    () =>
      withTools(async (install, root) => {
        const tool = install(
          'opencode',
          `
        if (process.argv.includes('--version')) process.stdout.write('1.18.35\\n');
        else process.stdout.write('openai/gpt-6.1-sol\\nlocal/my-model#high\\n');
      `,
        );
        expect(await discoverRepairModels('opencode', { PATH: root }, 'linux')).toEqual({
          harness: 'opencode',
          status: 'available',
          models: ['openai/gpt-6.1-sol', 'local/my-model#high'],
        });
        expect(await discoverRepairModels('codex', { PATH: root }, 'linux')).toEqual({
          harness: 'codex',
          status: 'unavailable',
          models: [],
        });
        install('opencode', "if (process.argv.includes('--version')) console.log('1.18.35');");
        expect(await listOpenCodeModels(tool, { PATH: root }, 'linux')).toEqual([]);
        install(
          'opencode',
          "if (process.argv.includes('--version')) console.log('1.18.35'); else console.log('format changed');",
        );
        expect(await listOpenCodeModels(tool, { PATH: root }, 'linux')).toBeNull();
        install('opencode', `for(let i=0;i<401;i++)console.log('provider/model-'+i);`);
        expect(await listOpenCodeModels(tool, { PATH: root }, 'linux')).toBeNull();
        install('opencode', 'process.exit(2);');
        expect(await listOpenCodeModels(tool, { PATH: root }, 'linux')).toBeNull();
      }),
  );

  it.skipIf(process.platform === 'win32')(
    'completes Codex app-server initialize/model-list with pagination',
    () =>
      withTools(async (install, root) => {
        const tool = install(
          'codex',
          `
        if (process.argv.includes('--version')) {
          process.stdout.write('codex-cli 0.162.1\\n');
          process.exit(0);
        }
        const rl = require('node:readline').createInterface({ input: process.stdin });
        rl.on('line', (line) => {
          const item = JSON.parse(line);
          if (item.method === 'initialize') console.log(JSON.stringify({id:1, result: {}}));
          if (item.method === 'model/list') console.log(JSON.stringify({
            id: 2,
            result: item.params.cursor
              ? { data: [{ model: 'gpt-latest', hidden: true }, { id: 'gpt-older' }], nextCursor: null }
              : { data: [{ model: 'gpt-latest' }, { id: 'gpt-older' }], nextCursor: 'page-2' }
          }));
        });
      `,
        );
        const expected = ['gpt-latest', 'gpt-older'];
        expect(await listCodexAppServerModels(tool, { PATH: root }, 'linux')).toEqual(expected);
        expect(await discoverRepairModels('codex', { PATH: root }, 'linux')).toEqual({
          harness: 'codex',
          status: 'available',
          models: expected,
        });
        install('codex', "process.stdout.write('invalid JSON\\n');");
        expect(await listCodexAppServerModels(tool, { PATH: root }, 'linux')).toBeNull();
        install('codex', 'process.exit(2);');
        expect(await listCodexAppServerModels(tool, { PATH: root }, 'linux')).toBeNull();
      }),
  );

  it('uses the optional Claude Agent SDK supportedModels control without sending a prompt', async () => {
    const close = vi.fn();
    const query = vi.fn(() => ({
      supportedModels: async () => [
        { value: 'claude-sonnet-5.5' },
        { value: 'claude-sonnet-5.5' },
        { id: 'claude-opus-5.5' },
      ],
      close,
    }));
    expect(await listClaudeSdkModels(async () => ({ query }))).toEqual([
      'claude-sonnet-5.5',
      'claude-opus-5.5',
    ]);
    expect(close).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ options: { tools: [] } }));
    expect(
      await listClaudeSdkModels(async () => ({
        query: () => ({ supportedModels: async () => [], close }),
      })),
    ).toEqual([]);
    expect(
      await listClaudeSdkModels(async () => {
        throw new Error('offline');
      }),
    ).toBeNull();
    expect(
      await listClaudeSdkModels(async () => ({
        query: () => ({
          supportedModels: async () => {
            throw new Error('auth');
          },
          close,
        }),
      })),
    ).toBeNull();
  });
});
