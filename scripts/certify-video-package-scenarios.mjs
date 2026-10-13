#!/usr/bin/env node
// #407: real CLI -> package -> player scenarios. Writes only temporary Projects.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = process.argv.includes('--web');
const native = process.argv.includes('--native');
if (process.argv.slice(2).some((arg) => !['--web', '--native'].includes(arg)))
  throw new Error('Usage: node scripts/certify-video-package-scenarios.mjs [--web] [--native]');
const cli = path.join(repo, 'build/cli/linux/noveltea');
const ffmpeg = path.join(repo, 'build/cli/linux/tools/ffmpeg/bin/ffmpeg');
const player = path.join(repo, 'build/linux-debug/apps/player/noveltea-player');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'nt407-package-cert-'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exec = (file, args, options = {}) => {
  const result = spawnSync(file, args, {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 120_000, ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(file + ' failed: ' +
      (result.error?.message || result.stderr || result.stdout || result.status).toString().slice(-6000));
  return options.withStderr ? result.stdout + result.stderr : result.stdout;
};
const load = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const save = async (p, obj) => fs.writeFile(p, JSON.stringify(obj, null, 2) + '\n');
const sourcePath = (dir) => path.join(dir, 'assets/video/opaque-colors.mp4');
const ffArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
const transcode = (dir, filename, filters, params) =>
  exec(ffmpeg, [...ffArgs, '-i', sourcePath(dir), '-map', '0:v:0',
    '-an', '-vf', filters, ...params, path.join(dir, 'assets/video', filename)]);
async function changeVideo(dir, filename, mime, ext) {
  const file = path.join(dir, 'records/assets/opaque-colors.json');
  const asset = await load(file);
  const relative = 'assets/video/' + filename;
  const bytes = await fs.readFile(path.join(dir, relative));
  Object.assign(asset.data, {
    source: { type: 'project-file', path: relative }, mimeType: mime,
    extension: ext, byteSize: bytes.length, contentHash: 'sha256:' + hash(bytes),
  });
  await save(file, asset);
}
async function projectFor(label, sampling, modify) {
  const dir = path.join(work, label, 'project');
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await fs.cp(path.join(repo, 'tests/projects/feature-lab'), dir, { recursive: true });
  const projectFile = path.join(dir, 'project.json');
  const project = await load(projectFile);
  project.entrypoint = { kind: 'room', id: 'world-composition' };
  project.settings.ui.systemLayouts = {};
  await save(projectFile, project);
  const roomFile = path.join(dir, 'records/rooms/world-composition.json');
  const room = await load(roomFile);
  room.data.presentationSpace.defaultView = {
    center: { x: 1200, y: 675 }, zoom: 1, rotationDegrees: 0,
  };
  await save(roomFile, room);
  const animationFile = path.join(dir, 'records/animations/opaque-color-loop.json');
  const animation = await load(animationFile);
  animation.data.motions[0].frameSampling = sampling;
  await save(animationFile, animation);
  if (modify) await modify({ dir, projectFile, animationFile });
  return dir;
}
const specs = [
  { label: 'source', sampling: { mode: 'source' }, endpoint: 2000 },
  { label: 'target-30000-1001',
    sampling: { mode: 'target-fps', fps: { numerator: 30000, denominator: 1001 } },
    endpoint: 2000, frames: 60 },
  { label: 'retain-50', sampling: { mode: 'retain-percent', percent: 50 },
    endpoint: 2000, frames: 30 },
  { label: 'vfr-source', sampling: { mode: 'source' }, endpoint: 2000,
    modify: async ({ dir }) => {
      transcode(dir, 'vfr.webm', 'select=not(mod(n\\,7))',
        ['-fps_mode', 'vfr', '-c:v', 'libvpx-vp9', '-threads', '1']);
      await changeVideo(dir, 'vfr.webm', 'video/webm', '.webm');
    } },
  { label: 'upsample-10-to-24',
    sampling: { mode: 'target-fps', fps: { numerator: 24, denominator: 1 } },
    endpoint: 2000, frames: 48,
    modify: async ({ dir }) => {
      transcode(dir, 'ten.webm', 'fps=10',
        ['-fps_mode', 'cfr', '-c:v', 'libvpx-vp9', '-threads', '1']);
      await changeVideo(dir, 'ten.webm', 'video/webm', '.webm');
    } },
  { label: 'full-range', sampling: { mode: 'source' }, endpoint: 3000, frames: 90,
    modify: async ({ animationFile }) => {
      const a = await load(animationFile);
      a.data.motions[0].sourceRange = { startMs: 0, endMs: 3000 };
      await save(animationFile, a);
    } },
  { label: 'locale-fr', sampling: { mode: 'source' }, endpoint: 2000,
    modify: async ({ projectFile }) => {
      const p = await load(projectFile);
      p.export.runtime.localization.defaultLocale = 'fr';
      await save(projectFile, p);
    } },
  { label: 'source-revision', sampling: { mode: 'source' }, endpoint: 2000,
    modify: async ({ dir }) => {
      transcode(dir, 'revised.mp4', 'hflip', ['-c:v', 'mpeg4', '-q:v', '2']);
      await changeVideo(dir, 'revised.mp4', 'video/mp4', '.mp4');
    } },
  ...['smpte2084', 'arib-std-b67'].map((transfer) => ({
    label: 'hdr-' + transfer, sampling: { mode: 'source' }, endpoint: 2000,
    modify: async ({ dir }) => {
      const filters = [
        'format=yuv444p10le',
        'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
        'zscale=p=bt2020:t=' + transfer + ':m=bt2020nc:r=tv',
        'format=yuv422p10le',
        'setparams=range=tv:color_primaries=bt2020:color_trc=' + transfer + ':colorspace=bt2020nc',
      ].join(',');
      transcode(dir, 'hdr.mov', filters, ['-c:v', 'prores_ks', '-profile:v', '3',
        '-pix_fmt', 'yuv422p10le', '-color_primaries', 'bt2020',
        '-color_trc', transfer, '-colorspace', 'bt2020nc',
        '-color_range', 'tv', '-movflags', '+write_colr']);
      await changeVideo(dir, 'hdr.mov', 'video/quicktime', '.mov');
    },
  })),
];
function fromZip(archive, item, encoding = 'utf8') {
  return exec('unzip', ['-p', archive, item], { encoding });
}
async function nativeSmoke(archive, label) {
  const dir = path.join(work, label, 'native');
  await fs.mkdir(dir, { recursive: true });
  const bytes = await fs.readFile(archive);
  await fs.writeFile(path.join(dir, 'game.ntpkg'), bytes);
  await save(path.join(dir, 'player.json'), {
    format: 'noveltea.player-config', formatVersion: 1,
    displayName: 'NovelTea Video Certification',
    applicationId: 'org.noveltea.video-certification',
    saveNamespace: 'org.noveltea.video-certification',
    versionName: '1.0.0',
    package: { path: 'game.ntpkg', sha256: hash(bytes) }, capabilities: [],
    display: { referenceResolution: { width: 1920, height: 1080 },
      worldRasterPolicy: 'capped', barColor: '#000000' },
    accessibility: {
      uiScale: { enabled: true, minimum: 1, maximum: 2 },
      textScale: { enabled: true, minimum: 1, maximum: 2 },
    },
  });
  const log = exec(player, ['--player-config', path.join(dir, 'player.json'),
    '--smoke-run-runtime'], {
    env: { ...process.env, SDL_AUDIODRIVER: 'dummy',
      NOVELTEA_PLAYER_SMOKE_FRAMES: '150',
      XDG_DATA_HOME: path.join(work, label, 'native-data') },
    timeout: 100_000,
    withStderr: true,
  });
  if (!log.includes('NOVELTEA_PLAYER_READY') ||
      !log.includes('[video] backend=libvpx-vp9') ||
      !log.includes('frame limit reached: 150') ||
      !log.includes('shutdown complete'))
    throw new Error(label + ': native player did not finish: ' + log.slice(-4000));
}
async function browserSmoke(archive) {
  exec(process.execPath, [path.join(repo, 'scripts/web-player-package-smoke.mjs'),
    '--build-dir', path.join(repo, 'build/web-release'), '--video',
    '--start-via-title', '--package', archive], {
    cwd: repo, timeout: 110_000,
    env: { ...process.env,
      NOVELTEA_WEB_SMOKE_ANGLE_BACKEND: process.env.NOVELTEA_WEB_SMOKE_ANGLE_BACKEND || 'swiftshader',
      NOVELTEA_WEB_PLAYER_SMOKE_TIMEOUT_MS: '75000' },
  });
}
try {
  const reports = [];
  for (const { label, sampling, endpoint, frames: expectedFrames, modify } of specs) {
    const dir = await projectFor(label, sampling, modify);
    const archive = path.join(work, label, 'game.ntpkg');
    const response = JSON.parse(exec(cli, [
      '--no-daemon', '--json', '--project', dir, 'package', 'export',
      '--output', archive, '--allow-localization-warnings',
    ], { cwd: repo }));
    if (!response.success) throw new Error(label + ': ' + JSON.stringify(response.diagnostics));
    const manifest = JSON.parse(fromZip(archive, 'assets/.prepared-media/manifest.json'));
    if (manifest.motions.length !== 1 || manifest.motions[0].representation !== 'opaque-vp9-webm')
      throw new Error(label + ': missing canonical VP9 representation');
    const motion = manifest.motions[0];
    const durations = motion.frames.map((f) => f.durationMs);
    if (!durations.length || durations.some((v) => !Number.isInteger(v) || v <= 0) ||
        durations.reduce((a, b) => a + b, 0) !== endpoint ||
        (expectedFrames && durations.length !== expectedFrames))
      throw new Error(label + ': invalid frames or endpoint');
    const contentHash = hash(fromZip(archive, motion.browserVideo.path, 'buffer'));
    if (label === 'target-30000-1001') {
      const repeatedArchive = path.join(work, label, 'game-repeated.ntpkg');
      const again = JSON.parse(exec(cli, [
        '--no-daemon', '--json', '--project', dir, 'package', 'export',
        '--output', repeatedArchive, '--allow-localization-warnings',
      ], { cwd: repo }));
      if (!again.success ||
          fromZip(archive, 'assets/.prepared-media/manifest.json') !==
            fromZip(repeatedArchive, 'assets/.prepared-media/manifest.json') ||
          contentHash !== hash(fromZip(repeatedArchive, motion.browserVideo.path, 'buffer')))
        throw new Error('Rational FPS re-export produced non-deterministic prepared media.');
    }
    if (web) await browserSmoke(archive);
    if (native) await nativeSmoke(archive, label);
    const report = { label, frames: durations.length, endpointMs: endpoint, hash: contentHash.slice(0, 16) };
    reports.push({ ...report, fullHash: contentHash, preparedIdentity: motion.contentHash });
    process.stdout.write(JSON.stringify(report) + '\n');
  }
  const found = (name) => reports.find((item) => item.label === name);
  if (found('source').fullHash !== found('locale-fr').fullHash)
    throw new Error('Changing export locale changed unchanged source video.');
  if (found('source').preparedIdentity === found('source-revision').preparedIdentity)
    throw new Error('Edited source reused previous prepared-media identity.');
  const broken = await projectFor('corrupt-media', { mode: 'source' }, async ({ dir }) => {
    await fs.writeFile(sourcePath(dir), Buffer.from('not a video container'));
    await changeVideo(dir, 'opaque-colors.mp4', 'video/mp4', '.mp4');
  });
  const failedArchive = path.join(work, 'corrupt-media', 'should-not-publish.ntpkg');
  const failure = spawnSync(cli, [
    '--no-daemon', '--json', '--project', broken, 'package', 'export',
    '--output', failedArchive, '--allow-localization-warnings',
  ], { cwd: repo, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 120_000 });
  const rejected = JSON.parse(failure.stdout);
  if (failure.status === 0 || rejected.success ||
      !rejected.diagnostics.some((diagnostic) =>
        diagnostic.code === 'runtime-artifact.video-preparation.failed' &&
        diagnostic.severity === 'error')) {
    throw new Error('Corrupt source was not rejected with the typed video-preparation diagnostic.');
  }
  try {
    await fs.stat(failedArchive);
    throw new Error('Corrupt source published a partial runtime package.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  console.log('VIDEO_PACKAGE_CORRUPT_SOURCE_REJECTED');
  console.log('VIDEO_PACKAGE_CERTIFICATION_PASSED cases=' + reports.length +
    ' web=' + web + ' native=' + native);
} finally {
  await fs.rm(work, { recursive: true, force: true });
}
