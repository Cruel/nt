import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pin = JSON.parse(
  await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/shared/media-tool-pin.json'),
    'utf8',
  ),
);
export function mediaArtifactTarget(platform = process.platform, arch = process.arch) {
  const target = `${platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform}-${arch}`;
  if (!pin.artifacts[target]) throw new Error(`Unsupported private FFmpeg host: ${target}`);
  return target;
}

export function verifyMediaArchive(bytes, target) {
  const expected = pin.artifacts[target];
  if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error(`Pinned FFmpeg archive checksum mismatch: ${target}`);
}

export async function verifyPrivateMediaTools(root, target = mediaArtifactTarget()) {
  const provenance = JSON.parse(await readFile(path.join(root, 'PROVENANCE.json'), 'utf8'));
  if (
    provenance.platform !== target ||
    provenance.release_tag !== pin.release ||
    provenance.components?.ffmpeg?.version !== pin.version
  )
    throw new Error(
      `Wrong private FFmpeg provenance: expected ${pin.release}/${target}/${pin.version}`,
    );
  const sums = await readFile(path.join(root, 'SHA256SUMS'), 'utf8');
  const entries = new Set();
  for (const line of sums.trim().split('\n')) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) throw new Error('Invalid private FFmpeg file checksum record.');
    const [, digest, relative] = match;
    if (
      relative.includes('\\') ||
      relative.split('/').some((part) => part === '..' || part === '') ||
      path.isAbsolute(relative) ||
      entries.has(relative)
    )
      throw new Error(`Unsafe private FFmpeg checksum path: ${relative}`);
    entries.add(relative);
    const bytes = await readFile(path.join(root, ...relative.split('/')));
    if (createHash('sha256').update(bytes).digest('hex') !== digest)
      throw new Error(`Private FFmpeg file checksum mismatch: ${relative}`);
  }
  for (const required of [
    'PROVENANCE.json',
    'NOTICE.txt',
    'BUILD.log',
    target === 'windows-x64' ? 'bin/ffmpeg.exe' : 'bin/ffmpeg',
    'configuration/ffmpeg-buildconf.txt',
  ])
    if (!entries.has(required))
      throw new Error(`Incomplete private FFmpeg installation: ${required}`);
  for (const component of Object.values(provenance.components))
    if (!entries.has(`sources/${component.archive}`))
      throw new Error('Private FFmpeg corresponding sources are missing.');
  if (
    ![...entries].some((name) => name.startsWith('licenses/')) ||
    !entries.has('sources/build-recipe/ffmpeg/build.sh')
  )
    throw new Error('Private FFmpeg licenses/build recipe are missing.');
}

export async function stagePrivateMediaTools(installationRoot, options = {}) {
  const target = mediaArtifactTarget(options.platform, options.arch);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'noveltea-ffmpeg-'));
  try {
    const name = `noveltea-ffmpeg-${target}.tar.gz`;
    const bytes = options.archivePath
      ? await readFile(options.archivePath)
      : await (async () => {
          const response = await fetch(
            `https://github.com/Cruel/nt-tools/releases/download/${pin.release}/${name}`,
          );
          if (!response.ok) throw new Error(`FFmpeg download failed: HTTP ${response.status}`);
          return Buffer.from(await response.arrayBuffer());
        })();
    verifyMediaArchive(bytes, target);
    const archive = path.join(temporary, name);
    await writeFile(archive, bytes);
    const extracted = path.join(temporary, 'extracted');
    await mkdir(extracted);
    const result = spawnSync('tar', ['-xzf', archive, '-C', extracted], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `Cannot extract verified FFmpeg archive: ${result.error?.message ?? result.stderr}`,
      );
    await verifyPrivateMediaTools(extracted, target);
    const tools = path.join(installationRoot, 'tools');
    await mkdir(tools, { recursive: true });
    const pending = await mkdtemp(path.join(tools, '.ffmpeg-'));
    try {
      await cp(extracted, pending, { recursive: true });
      await rm(path.join(tools, 'ffmpeg'), { recursive: true, force: true });
      await rename(pending, path.join(tools, 'ffmpeg'));
    } finally {
      await rm(pending, { recursive: true, force: true });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3)
    throw new Error('Usage: node private-media-tools.mjs <installation-root>');
  await stagePrivateMediaTools(path.resolve(process.argv[2]), {
    archivePath: process.env.NOVELTEA_FFMPEG_ARCHIVE,
  });
}
