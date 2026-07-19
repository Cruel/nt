import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const editorRoot = path.resolve(import.meta.dirname, '..');
const candidates =
  process.platform === 'win32'
    ? [path.join(editorRoot, 'out', 'NovelTea Editor-win32-x64', 'noveltea-editor.exe')]
    : process.platform === 'darwin'
      ? [
          path.join(
            editorRoot,
            'out',
            'NovelTea Editor-darwin-arm64',
            'NovelTea Editor.app',
            'Contents',
            'MacOS',
            'NovelTea Editor',
          ),
        ]
      : [path.join(editorRoot, 'out', 'NovelTea Editor-linux-x64', 'noveltea-editor')];

const executable = process.argv[2] ? path.resolve(process.argv[2]) : candidates.find(existsSync);
if (!executable || !existsSync(executable)) {
  console.error(
    'Packaged NovelTea Editor executable not found. Run pnpm package first or pass its path.',
  );
  process.exit(2);
}

const child = spawn(executable, ['--noveltea-package-smoke'], {
  cwd: path.dirname(executable),
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk.toString();
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  output += chunk.toString();
  process.stderr.write(chunk);
});

const timeout = setTimeout(() => {
  child.kill('SIGKILL');
}, 30_000);

child.on('exit', (code, signal) => {
  clearTimeout(timeout);
  const marker = 'NOVELTEA_PACKAGE_SMOKE_RESULT=';
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith(marker));
  if (!line) {
    console.error(
      `Package smoke produced no result marker (exit=${code}, signal=${signal ?? 'none'}).`,
    );
    process.exit(1);
  }
  const result = JSON.parse(line.slice(marker.length));
  process.exit(code === 0 && result.success === true ? 0 : 1);
});
