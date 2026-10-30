import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// The development Node entrypoint only forwards to an installed C++ CLI;
// it has no Project reader, semantic cache or fallback engine.
function requireInstalledNativeCli(): string {
  const executable = process.env.NOVELTEA_NATIVE_CLI_PATH;
  if (!executable || !path.isAbsolute(executable))
    throw new Error('Native CLI requires an absolute installed executable path.');
  if (!statSync(executable).isFile())
    throw new Error('Native CLI requires a regular installed executable.');
  const proof = JSON.parse(
    readFileSync(path.join(path.dirname(executable), 'native-production-build.json'), 'utf8'),
  ) as Record<string, unknown>;
  const sha256 = (file: string) =>
    `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
  if (
    proof.contract !== 'noveltea.native-cli-production-build.v2' ||
    proof.runtime !== 'direct-cxx' ||
    proof.executableSha256 !== sha256(executable)
  )
    throw new Error('Native CLI does not match its installed C++ binary provenance.');
  return executable;
}

try {
  const executable = requireInstalledNativeCli();
  const forwarded = spawnSync(executable, process.argv.slice(2), {
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  });
  if (forwarded.error) throw forwarded.error;
  if (forwarded.signal) throw new Error(`Native CLI interrupted by ${forwarded.signal}.`);
  process.exitCode = forwarded.status ?? 70;
} catch (error) {
  process.stderr.write(`[native-cli] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 70;
}
