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
  return {
    command: platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args,
  };
}
