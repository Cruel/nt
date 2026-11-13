import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  probeRepairHarnesses,
  repairHarnessCommand,
} from '../../main/services/repair-harness-service';
import { repairHarnessLaunchArgumentsSchema } from '../../main/editor-ipc-trust-boundary';

describe('repair harness host boundary', () => {
  it('probes executable identity and excludes absent/non-executable/unrelated files', async () => {
    if (process.platform === 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-harness-'));
    const install = (name: string, output: string, mode = 0o755) => {
      const file = path.join(root, name);
      fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode });
    };
    try {
      const env = { PATH: root };
      expect(await probeRepairHarnesses(env, 'linux')).toEqual([]);
      install('claude', 'unrelated tool version 1.0');
      install('codex', 'codex-cli 0.162.1');
      install('opencode', '1.18.35', 0o644);
      // Executable identity includes a recognized --version response.
      expect(await probeRepairHarnesses(env, 'linux')).toEqual(['codex']);
      install('claude', '2.0.0 (Claude Code)');
      fs.chmodSync(path.join(root, 'opencode'), 0o755);
      expect(await probeRepairHarnesses(env, 'linux')).toEqual(['claude', 'codex', 'opencode']);
      fs.unlinkSync(path.join(root, 'codex'));
      expect(await probeRepairHarnesses(env, 'linux')).toEqual(['claude', 'opencode']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['claude', ['--print', '--']],
    ['codex', ['exec', '--']],
    ['opencode', ['run', '--']],
  ] as const)(
    '%s preserves all unsafe prompt characters as one argv value, no permission override',
    (harness, prefix) => {
      const prompt =
        '--dangerously-bypass-approvals && \'$(touch /tmp/bad)\'\r\nsecond line\n"; rm -rf /"';
      const command = repairHarnessCommand(harness, '/opt/bin/' + harness, prompt, 'linux');
      expect(command.executable).toBe('/opt/bin/' + harness);
      expect(command.args).toEqual([...prefix, prompt]);
      expect(command.args).not.toContain('--auto');
      expect(command.args).not.toContain('--dangerously-skip-permissions');
      expect(command.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(command.args).not.toContain('--model');
      expect(command.args).not.toContain('--sandbox');
    },
  );

  it.each(['claude', 'codex', 'opencode'] as const)(
    '%s appends only a valid explicit model override, omitting it for Default',
    (harness) => {
      const base = repairHarnessCommand(harness, '/tool', 'hello', 'linux').args;
      expect(base).not.toContain('--model');
      const args = repairHarnessCommand(
        harness,
        '/tool',
        'hello',
        'linux',
        'provider/model#high',
      ).args;
      expect(args).toEqual([...base.slice(0, -2), '--model', 'provider/model#high', '--', 'hello']);
      expect(() =>
        repairHarnessCommand(harness, '/tool', 'hello', 'linux', '--dangerous'),
      ).toThrow();
      expect(() => repairHarnessCommand(harness, '/tool', 'hello', 'linux', 'bad model')).toThrow();
    },
  );

  it('admits only bounded prompt, tool and identity rather than arbitrary terminal shell or cwd', () => {
    const request = {
      kind: 'candidate',
      id: 'candidate-id',
      harness: 'codex',
      prompt: 'line 1\nline 2',
      authorizeWeak: false,
      authorizeOlder: false,
      authorizeNewer: false,
    };
    expect(repairHarnessLaunchArgumentsSchema.parse([request])).toEqual([request]);
    expect(() => repairHarnessLaunchArgumentsSchema.parse([{ ...request, cwd: '/tmp' }])).toThrow();
    expect(
      repairHarnessLaunchArgumentsSchema.parse([
        {
          ...request,
          candidateRevision: `sha256:${'f'.repeat(64)}`,
        },
      ]),
    ).toHaveLength(1);
    expect(() =>
      repairHarnessLaunchArgumentsSchema.parse([{ ...request, candidateRevision: 'stale' }]),
    ).toThrow();
    expect(() =>
      repairHarnessLaunchArgumentsSchema.parse([{ ...request, shell: 'bash' }]),
    ).toThrow();
    expect(() =>
      repairHarnessLaunchArgumentsSchema.parse([{ ...request, harness: 'bash' }]),
    ).toThrow();
    expect(() =>
      repairHarnessLaunchArgumentsSchema.parse([{ ...request, prompt: 'x'.repeat(130 * 1024) }]),
    ).toThrow();
    expect(() =>
      repairHarnessLaunchArgumentsSchema.parse([{ ...request, prompt: 'x\0y' }]),
    ).toThrow();
  });
});
