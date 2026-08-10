import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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

export function invokeNovelTeaNativeOperation(command: string, payload: unknown): Promise<unknown> {
  const input = JSON.stringify(payload ?? {});
  if (Buffer.byteLength(input, 'utf8') > MAX_TOOL_INPUT_BYTES) {
    return Promise.reject(new Error('Editor tool payload is too large.'));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(resolveNovelTeaCliPath(), ['__editor-native', command], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('NovelTea native operation timed out.'));
    }, 30_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > 16 * 1024 * 1024) child.kill();
    });
    child.stderr.on('data', (chunk: string) => {
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
    child.stdin.end(input);
  });
}
