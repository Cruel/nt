import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Candidate-only Node tools entrypoint. It owns no Project parsing, caching,
// mutation or fallback: all public requests go to the SHA-bound native CLI.
// #521 will remove the old Node CLI when production switches atomically.
function requireInstalledNativeCli(): string {
  const executable = process.env.NOVELTEA_NATIVE_CLI_PATH;
  const manifest = process.env.NOVELTEA_NATIVE_CLI_MANIFEST;
  if (!executable || !manifest || !path.isAbsolute(executable) || !path.isAbsolute(manifest))
    throw new Error(
      'Native CLI candidate requires absolute installed executable and island manifest paths.',
    );
  if (!statSync(executable).isFile() || !statSync(manifest).isFile())
    throw new Error(
      'Native CLI candidate requires regular installed executable and provenance files.',
    );
  const proof = JSON.parse(
    readFileSync(path.join(path.dirname(executable), 'native-candidate-build.json'), 'utf8'),
  ) as Record<string, unknown>;
  const sha256 = (file: string) =>
    `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
  if (
    proof.contract !== 'noveltea.native-cli-candidate-build.v1' ||
    proof.executableSha256 !== sha256(executable) ||
    proof.islandProvenanceSha256 !== sha256(manifest)
  )
    throw new Error('Native CLI candidate does not match its installed binary/island provenance.');
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
  process.stderr.write(
    `[native-cli-candidate] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 70;
}
