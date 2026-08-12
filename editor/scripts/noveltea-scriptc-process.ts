import { spawnSync } from 'node:child_process';

export function runNovelTeaScriptcProcess(requestText: string): string {
  try {
    const request = JSON.parse(requestText) as {
      command: string;
      args: string[];
      cwd?: string;
      env?: Record<string, string>;
      maxBuffer?: number;
    };
    const maxBuffer =
      typeof request.maxBuffer === 'number' && Number.isSafeInteger(request.maxBuffer)
        ? request.maxBuffer
        : 64 * 1024 * 1024;
    const previousCwd = process.cwd();
    const previousEnvironment: Array<[key: string, value: string | undefined]> = [];
    try {
      if (request.cwd) process.chdir(request.cwd);
      for (const [key, value] of Object.entries(request.env ?? {})) {
        previousEnvironment.push([key, process.env[key]]);
        process.env[key] = value;
      }
      const result = spawnSync(request.command, request.args, {
        encoding: 'utf8',
        stdio: 'pipe',
        windowsHide: true,
      });
      if (result.error) throw result.error;
      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      if (stdout.length > maxBuffer || stderr.length > maxBuffer)
        throw new Error(`Child process output exceeded the ${String(maxBuffer)} byte limit.`);
      if (result.status !== 0)
        throw new Error(
          stderr.trim() ||
            stdout.trim() ||
            `Child process exited with status ${String(result.status)}${result.signal ? ` (${result.signal})` : ''}.`,
        );
      return JSON.stringify({ ok: true, stdout, stderr });
    } finally {
      for (const [key, value] of previousEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (process.cwd() !== previousCwd) process.chdir(previousCwd);
    }
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
