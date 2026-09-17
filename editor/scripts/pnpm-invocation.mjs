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
    // @pnpm/exe exposes npm_execpath as a native launcher, not JavaScript.
    // Passing that ELF file to Node makes Node parse its binary bytes as source.
    const isJavaScriptEntrypoint = /\.(?:cjs|mjs|js)$/i.test(pnpmEntrypoint);
    return isJavaScriptEntrypoint
      ? {
          command: nodeExecutable,
          args: [pnpmEntrypoint, ...args],
        }
      : { command: pnpmEntrypoint, args };
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
