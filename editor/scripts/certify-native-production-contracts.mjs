import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProductionCertificationMode } from './native-production-qualification.mjs';

// Preserve `noveltea:certify` as the public build/release entrypoint while
// qualifying the *ordinary installed native production* executable. Never
// consult an old Node CLI or enable a candidate-only execution route.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
if (argv[0] === '--') argv.shift();
if (argv[0]?.startsWith('--') && argv[0] !== '--cli-only')
  throw new Error('Usage: noveltea:certify [installed-cli] [--cli-only]');
const executable = path.resolve(
  argv[0] && argv[0] !== '--cli-only'
    ? argv.shift()
    : path.join(
        root,
        'build/cli',
        process.platform === 'win32'
          ? 'windows/noveltea.exe'
          : process.platform === 'darwin'
            ? 'macos/noveltea'
            : 'linux/noveltea',
      ),
);
const cliOnly = resolveProductionCertificationMode(argv, process.env.NOVELTEA_AUTHORING_NODE_ADDON);
if (argv.some((argument) => argument !== '--cli-only'))
  throw new Error('Usage: noveltea:certify [installed-cli] [--cli-only]');
const result = spawnSync(
  process.execPath,
  [
    path.join(root, 'editor/scripts/certify-native-candidate-contracts.mjs'),
    executable,
    '--production',
    ...(cliOnly ? ['--cli-only'] : []),
  ],
  { cwd: root, stdio: 'inherit', env: process.env, windowsHide: true },
);
if (result.error) throw result.error;
if (result.signal) throw new Error(`Native production certification interrupted: ${result.signal}`);
process.exitCode = result.status ?? 70;
