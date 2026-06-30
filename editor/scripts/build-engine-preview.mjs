import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: false,
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (error) => {
      console.error(error);
      resolve(1);
    });
  });
}

const configureArgs = ['--preset', 'web-release', `-DNOVELTEA_WEB_SHELL_FILE=${path.join(repoRoot, 'web', 'widget.html')}`];
const localRmluiBgfxDir = path.join(repoRoot, 'rmlui-bgfx');
if (process.env.NOVELTEA_USE_LOCAL_RMLUI_BGFX === 'ON') {
  configureArgs.push('-DNOVELTEA_USE_LOCAL_RMLUI_BGFX=ON');
  configureArgs.push(
    `-DNOVELTEA_LOCAL_RMLUI_BGFX_DIR=${process.env.NOVELTEA_LOCAL_RMLUI_BGFX_DIR ?? localRmluiBgfxDir}`,
  );
} else {
  try {
    const { statSync } = await import('node:fs');
    if (statSync(localRmluiBgfxDir).isDirectory()) {
      console.log(`[preview] using local rmlui-bgfx checkout at ${localRmluiBgfxDir}`);
      configureArgs.push('-DNOVELTEA_USE_LOCAL_RMLUI_BGFX=ON');
      configureArgs.push(`-DNOVELTEA_LOCAL_RMLUI_BGFX_DIR=${localRmluiBgfxDir}`);
    }
  } catch {
    // No local checkout; use the configured external dependency.
  }
}

if (process.env.NOVELTEA_PREBUILT_SHADER_ASSET_ROOT) {
  configureArgs.push(
    '-DNOVELTEA_COMPILE_SHADERS=OFF',
    `-DNOVELTEA_PREBUILT_SHADER_ASSET_ROOT=${process.env.NOVELTEA_PREBUILT_SHADER_ASSET_ROOT}`,
  );
}

const configure = await run('cmake', configureArgs);
if (configure !== 0) {
  process.exit(configure);
}

const buildArgs = [
  '--build',
  '--preset',
  'web-release',
  '--target',
  'noveltea-sandbox',
  '--parallel',
];

const build = await run('cmake', buildArgs);
process.exit(build);
