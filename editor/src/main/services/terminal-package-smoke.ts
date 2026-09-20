import * as nodePty from 'node-pty';
import { resolveDefaultTerminalShell } from './terminal-service';

export async function characterizePackagedNodePty(
  cwd = process.cwd(),
): Promise<Record<string, boolean>> {
  const shell = resolveDefaultTerminalShell();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  const marker = '__NOVELTEA_PTY_SMOKE__';
  const interactive = nodePty.spawn(shell, [], {
    cwd,
    env,
    cols: 80,
    rows: 24,
    name: 'xterm-256color',
  });
  let output = '';
  interactive.onData((data) => {
    output += data;
  });
  const exited = waitForPtyExit(interactive, 10_000);
  interactive.resize(97, 31);
  const resized = interactive.cols === 97 && interactive.rows === 31;
  interactive.write(
    process.platform === 'win32'
      ? `Write-Output '${marker}'; exit 23\r`
      : `printf '${marker}\\n'; exit 23\n`,
  );
  const exit = await exited;

  const terminated = nodePty.spawn(shell, [], {
    cwd,
    env,
    cols: 80,
    rows: 24,
    name: 'xterm-256color',
  });
  const terminatedExit = waitForPtyExit(terminated, 10_000);
  terminated.kill();
  await terminatedExit;

  return {
    spawn: true,
    io: output.includes(marker),
    resize: resized,
    exit: exit.exitCode === 23,
    terminate: true,
  };
}

function waitForPtyExit(
  pty: nodePty.IPty,
  timeoutMs: number,
): Promise<{ exitCode: number; signal?: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      try {
        pty.kill();
      } catch {
        // The timeout is already the actionable certification failure.
      }
      reject(new Error('Packaged PTY smoke timed out.'));
    }, timeoutMs);
    const subscription = pty.onExit((event) => {
      clearTimeout(timeout);
      subscription.dispose();
      resolve(event);
    });
  });
}
