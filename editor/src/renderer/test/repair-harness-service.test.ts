import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  probeRepairHarnesses,
  repairHarnessCommand,
  resolveRepairExecutionEnvironment,
} from '../../main/services/repair-harness-service';
import {
  repairHarnessLaunchArgumentsSchema,
  terminalRepairModelCatalogArgumentsSchema,
} from '../../main/editor-ipc-trust-boundary';

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

  it('discovers tools from the selected shell PATH, without installation-directory guesses', async () => {
    if (process.platform === 'win32') return;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'noveltea-gui-harness-home-'));
    const toolDirectory = path.join(home, 'arbitrary-custom-tools');
    const inheritedDirectory = path.join(home, 'inherited');
    const shell = path.join(home, 'zsh');
    fs.mkdirSync(toolDirectory);
    fs.mkdirSync(inheritedDirectory);
    const install = (name: string, output: string) =>
      fs.writeFileSync(path.join(toolDirectory, name), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, {
        mode: 0o755,
      });
    try {
      install('opencode', 'opencode v2.0.28');
      install('codex', 'codex-cli 0.164.0');
      // A shell startup script may print unrelated text. Only its bounded,
      // delimited PATH output is authoritative, never a guessed HOME subdir.
      fs.writeFileSync(
        shell,
        `#!/bin/sh\nprintf 'shell init noise\\n__NT_REPAIR_PATH_START__\\n%s\\n__NT_REPAIR_PATH_END__\\n' '${toolDirectory}'\n`,
        { mode: 0o755 },
      );
      const guiEnv = { HOME: home, PATH: inheritedDirectory, SHELL: shell };
      expect(await probeRepairHarnesses(guiEnv, 'linux')).toEqual([]);
      const resolved = await resolveRepairExecutionEnvironment(guiEnv, 'linux');
      expect(resolved.PATH).toBe(toolDirectory);
      expect(await probeRepairHarnesses(resolved, 'linux')).toEqual(['codex', 'opencode']);
      expect(guiEnv.PATH).toBe(inheritedDirectory);
      // Failed shell initialization cannot erase the inherited executable PATH.
      fs.writeFileSync(shell, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      expect((await resolveRepairExecutionEnvironment(guiEnv, 'linux')).PATH).toBe(
        inheritedDirectory,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ['claude', ['--']],
    ['codex', ['--']],
    ['opencode', ['--prompt']],
  ] as const)(
    '%s launches an interactive TUI with the initial prompt as one literal argv value',
    (harness, prefix) => {
      const prompt =
        '--dangerously-bypass-approvals && \'$(touch /tmp/bad)\'\r\nsecond line\n"; rm -rf /"';
      const command = repairHarnessCommand(harness, '/opt/bin/' + harness, prompt, 'linux');
      expect(command.executable).toBe('/opt/bin/' + harness);
      expect(command.args).toEqual([...prefix, prompt]);
      expect(command.args).not.toContain('--print');
      expect(command.args).not.toContain('exec');
      expect(command.args).not.toContain('run');
      expect(command.args).not.toContain('--auto');
      expect(command.args).not.toContain('--dangerously-skip-permissions');
      expect(command.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(command.args).not.toContain('--model');
      expect(command.args).not.toContain('--sandbox');
    },
  );

  it.each([
    ['claude', ['--model', 'provider/model#high', '--', 'hello']],
    ['codex', ['--model', 'provider/model#high', '--', 'hello']],
    // OpenCode v2 removed --model from its full TUI; mini is interactive
    // and supports both --model and --prompt without headless run.
    ['opencode', ['mini', '--model', 'provider/model#high', '--prompt', 'hello']],
  ] as const)(
    '%s preserves interactive behavior with a valid explicit model override',
    (harness, expected) => {
      const base = repairHarnessCommand(harness, '/tool', 'hello', 'linux').args;
      expect(base).not.toContain('--model');
      expect(
        repairHarnessCommand(harness, '/tool', 'hello', 'linux', 'provider/model#high').args,
      ).toEqual(expected);
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

  it('authenticates background model-catalog refresh flags without accepting arbitrary inputs', () => {
    expect(terminalRepairModelCatalogArgumentsSchema.parse(['codex'])).toEqual(['codex']);
    expect(terminalRepairModelCatalogArgumentsSchema.parse(['codex', true])).toEqual([
      'codex',
      true,
    ]);
    expect(() => terminalRepairModelCatalogArgumentsSchema.parse(['codex', 'refresh'])).toThrow();
    expect(() => terminalRepairModelCatalogArgumentsSchema.parse(['bash', true])).toThrow();
    expect(() =>
      terminalRepairModelCatalogArgumentsSchema.parse(['codex', true, '/tmp']),
    ).toThrow();
  });
});
