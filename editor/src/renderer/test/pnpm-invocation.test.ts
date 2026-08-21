import { describe, expect, it } from 'vite-plus/test';
// @ts-expect-error The coordinator helper is intentionally authored as a Node ESM script.
import { resolvePnpmInvocation } from '../../../scripts/pnpm-invocation.mjs';

describe('pnpm process invocation', () => {
  it('uses the active pnpm entrypoint through Node when available', () => {
    expect(
      resolvePnpmInvocation(['exec', 'vp', 'dev'], {
        environment: { npm_execpath: 'C:\\pnpm\\pnpm.cjs' },
        platform: 'win32',
        nodeExecutable: 'C:\\node\\node.exe',
      }),
    ).toEqual({
      command: 'C:\\node\\node.exe',
      args: ['C:\\pnpm\\pnpm.cjs', 'exec', 'vp', 'dev'],
    });
  });

  it('falls back to the platform-specific pnpm launcher', () => {
    expect(
      resolvePnpmInvocation(['run', 'build'], {
        environment: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
        platform: 'win32',
        nodeExecutable: 'node.exe',
      }),
    ).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', 'run', 'build'],
    });
    expect(
      resolvePnpmInvocation(['run', 'build'], {
        environment: {},
        platform: 'linux',
        nodeExecutable: '/usr/bin/node',
      }),
    ).toEqual({ command: 'pnpm', args: ['run', 'build'] });
  });
});
