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

const exec = promisify(execFile);
const MAX_PROMPT_BYTES = 128 * 1024;

export function localRepairExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const win = platform === 'win32';
  for (const directory of (env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter(Boolean)) {
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
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<RepairHarness[]> {
  const results = await Promise.all(
    REPAIR_HARNESSES.map(async (harness) => {
      const candidate = localRepairExecutable(harness, env, platform);
      if (!candidate) return null;
      try {
        const invocation = repairHarnessProcessCommand(candidate, ['--version'], platform);
        const { stdout, stderr } = await exec(invocation.executable, invocation.args, {
          env,
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
              : /^\s*\d+\.\d+\.\d+/u.test(version);
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
  // Direct argv, never an interpolated shell line. Defaults remain entirely
  // owned by the selected tool (model, authorization, sandbox, profiles).
  const modelArgs = model ? ['--model', model] : [];
  const args =
    harness === 'claude'
      ? ['--print', ...modelArgs, '--', prompt]
      : harness === 'codex'
        ? ['exec', ...modelArgs, '--', prompt]
        : ['run', ...modelArgs, '--', prompt];
  return repairHarnessProcessCommand(executable, args, platform);
}

export async function installedRepairHarnessCommand(
  harness: RepairHarness,
  prompt: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  model = '',
): Promise<{ executable: string; args: string[] }> {
  if (!(await probeRepairHarnesses(env, platform)).includes(harness))
    throw new Error(
      `The selected ${harness} executable is no longer available. Recheck installed tools.`,
    );
  const executable = localRepairExecutable(harness, env, platform);
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
