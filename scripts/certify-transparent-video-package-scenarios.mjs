#!/usr/bin/env node
// #409: temporary alpha-bearing MOV -> actual CLI package -> native/Web player.
// Never changes the in-tree Feature Lab source fixture.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'build/cli/linux/noveltea');
const nodeCli = path.join(root, 'editor/dist-electron/tools/noveltea.mjs');
// The Node CLI is the source-of-truth export path; the separately bundled
// ScriptC standalone launcher can be opted into for its own certification.
const useNodeCli = process.env.NOVELTEA_ALPHA_STANDALONE_CLI !== '1';
const ffmpeg = path.join(root, 'build/cli/linux/tools/ffmpeg/bin/ffmpeg');
const player = path.join(root, 'build/linux-debug/apps/player/noveltea-player');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'noveltea-409-package-'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exec = (file, args, options = {}) => {
  const result = spawnSync(file, args, {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 180_000, ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(file + ' failed: ' +
      (result.error?.message || result.stderr || result.stdout || result.status).toString().slice(-7000));
  return result.stdout;
};
const fromPackage = (pkg, file) => exec('unzip', ['-p', pkg, file]);
try {
  const project = path.join(work, 'project');
  await fs.cp(path.join(root, 'tests/projects/feature-lab'), project, { recursive: true });
  const projectFile = path.join(project, 'project.json');
  const projectDoc = JSON.parse(await fs.readFile(projectFile, 'utf8'));
  projectDoc.entrypoint = { kind: 'room', id: 'world-composition' };
  projectDoc.settings.ui.systemLayouts = {};
  await fs.writeFile(projectFile, JSON.stringify(projectDoc));
  const roomFile = path.join(project, 'records/rooms/world-composition.json');
  const room = JSON.parse(await fs.readFile(roomFile, 'utf8'));
  room.data.presentationSpace.defaultView = {
    center: { x: 1200, y: 675 }, zoom: 1, rotationDegrees: 0,
  };
  await fs.writeFile(roomFile, JSON.stringify(room));

  const alphaSource = 'assets/video/transparent-colors.mov';
  const input = path.join(project, 'assets/video/opaque-colors.mp4');
  const output = path.join(project, alphaSource);
  exec(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input,
    '-an', '-vf',
    "format=yuva444p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(Y,8),if(lt(mod(N,30),15),0,255),if(lt(X,32),0,if(lt(X,64),128,255)))'",
    '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le',
    '-alpha_bits', '16', '-threads', '2', output,
  ]);
  const assetFile = path.join(project, 'records/assets/opaque-colors.json');
  const asset = JSON.parse(await fs.readFile(assetFile, 'utf8'));
  const sourceBytes = await fs.readFile(output);
  asset.data.source.path = alphaSource;
  asset.data.mimeType = 'video/quicktime';
  asset.data.extension = '.mov';
  asset.data.byteSize = sourceBytes.length;
  asset.data.contentHash = 'sha256:' + sha(sourceBytes);
  await fs.writeFile(assetFile, JSON.stringify(asset));
  const archive = path.join(work, 'transparent.ntpkg');
  const response = JSON.parse(exec(useNodeCli ? process.execPath : cli, [
    ...(useNodeCli ? [nodeCli] : []), '--no-daemon', '--json', '--project', project,
    'package', 'export', '--output', archive, '--allow-localization-warnings',
  ], { cwd: root }));
  if (!response.success)
    throw new Error('Transparent package export failed: ' + JSON.stringify(response.diagnostics));
  const manifest = JSON.parse(fromPackage(archive, 'assets/.prepared-media/manifest.json'));
  if (manifest.motions.length !== 1)
    throw new Error('Expected one prepared Motion: ' + JSON.stringify(manifest));
  const motion = manifest.motions[0];
  const alphaPath = motion.alphaWebp?.path;
  if (!alphaPath || !alphaPath.endsWith('/alpha.webp') || !motion.browserVideo.path.endsWith('/opaque.webm'))
    throw new Error('Compiled transparent motion is missing its paired WebP: ' + JSON.stringify(motion));
  const alpha = Buffer.from(exec('unzip', ['-p', archive, alphaPath], { encoding: 'buffer' }));
  if (alpha.toString('ascii', 0, 4) !== 'RIFF' || alpha.length < 40 ||
      !alpha.includes(Buffer.from('ANIM')) || !alpha.includes(Buffer.from('ANMF')))
    throw new Error('Packaged alpha WebP must be an animated, lossless RIFF stream.');
  const durations = motion.frames.map((frame) => frame.durationMs);
  if (!durations.length || durations.reduce((sum, value) => sum + value, 0) !== 2000)
    throw new Error('Source color/alpha timeline changed.');
  console.log('ALPHA_PACKAGE_OK frames=' + durations.length + ' webpBytes=' + alpha.length +
              ' packageBytes=' + (await fs.stat(archive)).size);
  const browser = process.argv.includes('--web');
  const native = process.argv.includes('--native');
  if (!browser && !native)
    throw new Error('Pass --native or --web to exercise an actual player.');
  if (native) {
    const staged = path.join(work, 'native');
    await fs.mkdir(staged);
    await fs.copyFile(archive, path.join(staged, 'game.ntpkg'));
    await fs.writeFile(path.join(staged, 'player.json'), JSON.stringify({
      format: 'noveltea.player-config', formatVersion: 1,
      displayName: 'Alpha Video Player', applicationId: 'org.noveltea.alpha',
      saveNamespace: 'org.noveltea.alpha', versionName: '1.0.0',
      package: { path: 'game.ntpkg', sha256: sha(await fs.readFile(archive)) },
      capabilities: [],
      display: { referenceResolution: { width: 1920, height: 1080 },
        worldRasterPolicy: 'capped', barColor: '#000000' },
      accessibility: { uiScale: { enabled: true, minimum: 1, maximum: 2 },
        textScale: { enabled: true, minimum: 1, maximum: 2 } },
    }));
    const log = exec('xvfb-run', ['-a', player, '--player-config', path.join(staged, 'player.json'),
      '--smoke-run-runtime'], {
      cwd: root, timeout: 130_000,
      env: { ...process.env, SDL_AUDIODRIVER: 'dummy',
        XDG_DATA_HOME: path.join(work, 'native-data'), NOVELTEA_PLAYER_SMOKE_FRAMES: '150' },
    });
    if (!log.includes('NOVELTEA_PLAYER_READY') || !log.includes('frame limit reached'))
      throw new Error('Native packaged alpha playback did not complete: ' + log.slice(-4500));
    console.log('ALPHA_NATIVE_PLAYER_OK');
  }
  if (browser) {
    exec(process.execPath, [path.join(root, 'scripts/web-player-package-smoke.mjs'),
      '--build-dir', path.join(root, 'build/web-debug'), '--package', archive,
      '--video', '--alpha'], {
      cwd: root, timeout: 150_000,
      env: { ...process.env, NOVELTEA_WEB_PLAYER_SMOKE_TIMEOUT_MS: '110000',
        NOVELTEA_WEB_SMOKE_ANGLE_BACKEND:
          process.env.NOVELTEA_WEB_SMOKE_ANGLE_BACKEND || 'swiftshader' },
    });
    console.log('ALPHA_WEB_PLAYER_OK');
  }
} finally {
  if (!process.env.NOVELTEA_KEEP_ALPHA_PACKAGE_FIXTURE)
    await fs.rm(work, { recursive: true, force: true });
  else
    console.log('ALPHA_PACKAGE_FIXTURE=' + work);
}
