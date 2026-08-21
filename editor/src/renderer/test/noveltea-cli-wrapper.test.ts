import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vite-plus/test';

describe('NovelTea CLI development wrapper', () => {
  it('removes the package-script argument separator before invoking the CLI', () => {
    const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const result = spawnSync(pnpmCommand, ['run', 'noveltea', '--', '--json', '--version'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const jsonLine = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .findLast((line) => line.startsWith('{'));
    expect(jsonLine).toBeDefined();
    expect(JSON.parse(jsonLine!)).toMatchObject({ success: true, exitCode: 0 });
  }, 35_000);
});
