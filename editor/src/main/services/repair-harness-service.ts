import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  REPAIR_HARNESSES,
  validRepairModelId,
  type RepairHarness,
} from '../../shared/repair-harness';
import { resolveNovelTeaCliPath } from '../../shared/noveltea-cli-subprocess';
import { resolveDefaultTerminalShell } from './terminal-service';

const exec = promisify(execFile);
const MAX_PROMPT_BYTES = 128 * 1024;
const SHELL_PATH_START = '__NT_REPAIR_PATH_START__';
const SHELL_PATH_END = '__NT_REPAIR_PATH_END__';

/**
 * Desktop launchers may not inherit the PATH initialized by a user's shell.
 * Query the same default shell as Terminal, rather than guessing install dirs.
 * Never interpolate Project data or tool prompts into the shell command.
 */
export async function resolveRepairExecutionEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<NodeJS.ProcessEnv> {
  const shell = resolveDefaultTerminalShell(platform, env);
  const name = path.basename(shell).toLowerCase();
  let args: string[];
  if (platform === 'win32') {
    if (!['pwsh.exe', 'powershell.exe'].includes(name)) return { ...env };
    args = [
      '-NoLogo',
      '-Command',
      "Write-Output '__NT_REPAIR_PATH_START__'; Write-Output $env:PATH; Write-Output '__NT_REPAIR_PATH_END__'",
    ];
  } else {
    const command = 'printf "\\n__NT_REPAIR_PATH_START__\\n%s\\n__NT_REPAIR_PATH_END__\\n" "$PATH"';
    if (name === 'zsh') args = ['-ilc', command];
    else if (name === 'bash') args = ['-ic', command];
    else if (name === 'sh') args = ['-c', command];
    else return { ...env };
  }
  try {
    const { stdout } = await exec(shell, args, {
      env,
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    // PowerShell emits CRLF on Windows; normalize marker boundaries only.
    const output = stdout.replaceAll('\r\n', '\n');
    const start = output.lastIndexOf(SHELL_PATH_START + '\n');
    if (start === -1) return { ...env };
    const from = start + SHELL_PATH_START.length + 1;
    const end = output.indexOf('\n' + SHELL_PATH_END, from);
    if (end === -1) return { ...env };
    const shellPath = output.slice(from, end);
    if (
      !shellPath ||
      shellPath.length > 32 * 1024 ||
      /[\r\n]/u.test(shellPath) ||
      shellPath.includes('\0')
    )
      return { ...env };
    return { ...env, PATH: shellPath };
  } catch {
    return { ...env };
  }
}

export function localRepairExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const win = platform === 'win32';
  const searchDirectories = (env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter(Boolean);
  for (const directory of new Set(searchDirectories)) {
    if (!path.isAbsolute(directory)) continue;
    for (const suffix of win ? ['.exe', '.cmd'] : ['']) {
      const file = path.join(directory, name + suffix);
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (!win) fs.accessSync(file, fs.constants.X_OK);
        if (win && suffix === '.cmd') {
          // npm/pnpm shims also install a PowerShell companion. Never pass
          // untrusted prompt argv through cmd.exe's second parsing stage.
          const script = file.slice(0, -4) + '.ps1';
          if (!fs.statSync(script).isFile()) continue;
          return script;
        }
        return file;
      } catch {
        // Not installed at this PATH entry.
      }
    }
  }
  return null;
}

function windowsShimCommand(
  executable: string,
  args: string[],
): { executable: string; args: string[] } {
  // No interpolated prompt, path or model ever becomes PowerShell source:
  // only base64 literals appear in the fixed script. Shell metacharacters in
  // the prompt are decoded as an argument, not evaluated as script text.
  const decode = (value: string) =>
    `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString('base64')}'))`;
  const command = [
    `$tool=${decode(executable)}`,
    ...args.map((arg, index) => `$arg${index}=${decode(arg)}`),
    `& $tool ${args.map((_, index) => `$arg${index}`).join(' ')}`,
    'exit $LASTEXITCODE',
  ].join('; ');
  return {
    executable: 'powershell.exe',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64'),
    ],
  };
}

export function repairHarnessProcessCommand(
  executable: string,
  args: string[],
  platform: NodeJS.Platform,
): {
  executable: string;
  args: string[];
} {
  return platform === 'win32' && path.extname(executable).toLowerCase() === '.ps1'
    ? windowsShimCommand(executable, args)
    : { executable, args };
}

export async function probeRepairHarnesses(
  env?: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<RepairHarness[]> {
  const effectiveEnv = env ?? (await resolveRepairExecutionEnvironment());
  const results = await Promise.all(
    REPAIR_HARNESSES.map(async (harness) => {
      const candidate = localRepairExecutable(harness, effectiveEnv, platform);
      if (!candidate) return null;
      try {
        const invocation = repairHarnessProcessCommand(candidate, ['--version'], platform);
        const { stdout, stderr } = await exec(invocation.executable, invocation.args, {
          env: effectiveEnv,
          windowsHide: true,
          timeout: 2_500,
          maxBuffer: 32 * 1024,
        });
        const version = stdout + stderr;
        const identified =
          harness === 'claude'
            ? /Claude Code/iu.test(version)
            : harness === 'codex'
              ? /codex(?:-cli)?\s+\d/u.test(version)
              : /^\s*(?:opencode\s+v?)?\d+\.\d+\.\d+/iu.test(version);
        return identified ? harness : null;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((result): result is RepairHarness => result !== null);
}

export function repairHarnessCommand(
  harness: RepairHarness,
  executable: string,
  prompt: string,
  platform: NodeJS.Platform = process.platform,
  model = '',
): { executable: string; args: string[] } {
  if (
    !prompt.trim() ||
    Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES ||
    prompt.includes('\0')
  )
    throw new Error('Repair prompt must be nonempty, valid text of at most 128 KiB.');
  if (model !== '' && !validRepairModelId(model))
    throw new Error('The selected model ID is invalid. Choose Default or enter a valid model ID.');
  // Launch only interactive TUIs into the existing PTY. The prompt is a
  // literal argv value, never an interpolated shell line. Keep each harness's
  // configured permissions, sandbox, authentication and model as defaults.
  const modelArgs = model ? ['--model', model] : [];
  // OpenCode v2's full-screen command accepts --prompt but not --model.
  // Its "mini" TUI is also interactive and permits an explicit model.
  const args =
    harness === 'opencode'
      ? model
        ? ['mini', ...modelArgs, '--prompt', prompt]
        : ['--prompt', prompt]
      : [...modelArgs, '--', prompt];
  return repairHarnessProcessCommand(executable, args, platform);
}

export async function installedRepairHarnessCommand(
  harness: RepairHarness,
  prompt: string,
  env?: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  model = '',
): Promise<{ executable: string; args: string[] }> {
  const effectiveEnv = env ?? (await resolveRepairExecutionEnvironment());
  if (!(await probeRepairHarnesses(effectiveEnv, platform)).includes(harness))
    throw new Error(
      `The selected ${harness} executable is no longer available. Recheck installed tools.`,
    );
  const executable = localRepairExecutable(harness, effectiveEnv, platform);
  if (!executable) throw new Error(`The selected ${harness} executable is no longer available.`);
  return repairHarnessCommand(harness, executable, prompt, platform, model);
}

export async function prepareRepairAgentKit(root: string, authorizeWeak: boolean): Promise<void> {
  const args = [
    '--json',
    '--no-daemon',
    'repair',
    'project',
    root,
    ...(authorizeWeak ? ['--confirm-weak'] : []),
  ];
  let stdout: string;
  try {
    ({ stdout } = await exec(resolveNovelTeaCliPath(), args, {
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (error) {
    // The CLI returns actionable machine-readable diagnostics on failure.
    stdout = (error as { stdout?: string }).stdout ?? '';
    if (!stdout)
      throw new Error(
        `NovelTea Agent Kit preparation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
  }
  let result: { success?: unknown; diagnostics?: { code?: string; message?: string }[] };
  try {
    result = JSON.parse(stdout) as typeof result;
  } catch {
    throw new Error('NovelTea Agent Kit preparation returned an invalid native CLI response.');
  }
  if (result.success !== true) {
    const detail = result.diagnostics
      ?.map((item) => `${item.code ?? 'Preparation error'}: ${item.message ?? ''}`)
      .join('\n');
    throw new Error(
      detail || 'NovelTea Agent Kit preparation failed. Inspect the candidate and retry.',
    );
  }
}
