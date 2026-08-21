import process from 'node:process';

export function resolvePnpmInvocation(
  args,
  {
    environment = process.env,
    platform = process.platform,
    nodeExecutable = process.execPath,
  } = {},
) {
  const pnpmEntrypoint = environment.npm_execpath;
  if (pnpmEntrypoint) {
    return {
      command: nodeExecutable,
      args: [pnpmEntrypoint, ...args],
    };
  }
  if (platform === 'win32') {
    return {
      command: environment.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', ...args],
    };
  }
  return {
    command: 'pnpm',
    args,
  };
}
