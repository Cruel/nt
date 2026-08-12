import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_TOOL_INPUT_BYTES = 32 * 1024 * 1024;

function electronRuntimeState(): { packaged: boolean; resourcesPath?: string } {
  const runtime = process as NodeJS.Process & {
    defaultApp?: boolean;
    resourcesPath?: string;
  };
  const electron = typeof process.versions.electron === 'string';
  return {
    packaged: electron && runtime.defaultApp !== true && !!runtime.resourcesPath,
    resourcesPath: runtime.resourcesPath,
  };
}

function cliName() {
  return process.platform === 'win32' ? 'noveltea.exe' : 'noveltea';
}

function repoRootCandidates() {
  const cwd = process.cwd();
  const runtime = electronRuntimeState();
  return [
    path.resolve(cwd, '..'),
    path.resolve(cwd),
    ...(runtime.resourcesPath
      ? [path.resolve(runtime.resourcesPath, '..'), path.resolve(runtime.resourcesPath, '..', '..')]
      : []),
  ];
}

export function resolveNovelTeaCliPath(): string {
  if (process.env.NOVELTEA_CLI) return process.env.NOVELTEA_CLI;

  const runtime = electronRuntimeState();
  if (runtime.packaged && runtime.resourcesPath) {
    return path.join(runtime.resourcesPath, 'bin', cliName());
  }

  const relativeCandidates = [path.join('build', 'cli', 'linux', cliName())];
  for (const root of repoRootCandidates()) {
    for (const relative of relativeCandidates) {
      const candidate = path.resolve(root, relative);
      if (existsSync(candidate)) return candidate;
    }
  }

  return path.resolve(process.cwd(), '..', 'build', 'cli', 'linux', cliName());
}

export async function invokeNovelTeaNativeOperation(
  command: string,
  payload: unknown,
): Promise<unknown> {
  const input = JSON.stringify(payload ?? {});
  if (Buffer.byteLength(input, 'utf8') > MAX_TOOL_INPUT_BYTES) {
    return Promise.reject(new Error('Editor tool payload is too large.'));
  }

  const inputRoot = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-input-'));
  const inputPath = path.join(inputRoot, 'request.json');
  let inputFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await writeFile(inputPath, input, { encoding: 'utf8', mode: 0o600 });
    inputFile = await open(inputPath, 'r');
    return await new Promise((resolve, reject) => {
      // Use a private regular file so the standalone native bridge receives a seekable, portable
      // stdin payload instead of depending on child-process pipe behavior.
      const child = spawn(resolveNovelTeaCliPath(), ['__editor-native', command], {
        stdio: [inputFile!.fd, 'pipe', 'pipe'],
      });
      if (!child.stdout || !child.stderr) {
        child.kill();
        reject(new Error('NovelTea native operation did not expose output pipes.'));
        return;
      }
      const childStdout = child.stdout;
      const childStderr = child.stderr;
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('NovelTea native operation timed out.'));
      }, 30_000);

      childStdout.setEncoding('utf8');
      childStderr.setEncoding('utf8');
      childStdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, 'utf8') > 16 * 1024 * 1024) child.kill();
      });
      childStderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        let parsed: unknown = null;
        try {
          parsed = stdout ? JSON.parse(stdout) : null;
        } catch (parseError) {
          reject(
            new Error(
              `NovelTea native operation returned invalid JSON.${stderr ? ` stderr: ${stderr}` : ''} ${String(parseError)}`,
            ),
          );
          return;
        }

        if (code !== 0 && !parsed) {
          reject(
            new Error(
              stderr || `NovelTea native operation failed with exit code ${code ?? 'unknown'}.`,
            ),
          );
          return;
        }
        resolve(parsed);
      });
    });
  } finally {
    await inputFile?.close().catch(() => undefined);
    await rm(inputRoot, { recursive: true, force: true });
  }
}
