import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareEditorRelease } from '../../scripts/ci/promote-editor-candidate.mjs';

const sha = (data) => createHash('sha256').update(data).digest('hex');
const tag = 'v4.5.6';

async function stageEditor(platform) {
  const root = await mkdtemp(path.join(tmpdir(), 'noveltea-editor-release-'));
  const stage = path.join(root, 'candidate');
  const files = {
    linux: ['NovelTea.AppImage', 'NovelTea.deb', 'NovelTea.rpm'],
    windows: ['NovelTea-Setup.exe'],
    macos: ['NovelTea.dmg', 'NovelTea.zip'],
  }[platform];
  await mkdir(path.join(stage, 'packages'), { recursive: true });
  const artifacts = [];
  const manifestFiles = [];
  for (const name of files) {
    const bytes = Buffer.from('signed original installer: ' + name);
    await writeFile(path.join(stage, 'packages', name), bytes);
    const entry = { fileName: name, sha256: sha(bytes), size: bytes.length };
    artifacts.push(entry);
    manifestFiles.push({ path: 'packages/' + name, sha256: sha(bytes), size: bytes.length });
  }
  const descriptor = {
    format: 'noveltea-editor-candidate-distribution', version: 1,
    platform, arch: platform === 'macos' ? 'arm64' : 'x64',
    releaseTag: tag, primary: files[0], artifacts,
  };
  await writeFile(path.join(stage, 'editor-distribution.json'), JSON.stringify(descriptor));
  await writeFile(path.join(stage, 'editor-package'), files[0] + '\n' + artifacts[0].sha256 + '\n');
  await writeFile(path.join(stage, 'noveltea-candidate.json'), JSON.stringify({ files: manifestFiles }));
  const candidate = {
    id: platform + '-editor', kind: 'editor-package',
    target: platform + '-' + descriptor.arch + '-editor', executable: 'editor-package',
  };
  const destination = path.join(root, 'editor/out/electron-builder/latest-artifact.json');
  return { root, stage, files, artifacts, candidate, destination };
}

test('Editor release reuses exact verified installers for Linux/Windows/macOS, without changing bytes', async () => {
  for (const platform of ['linux', 'windows', 'macos']) {
    const f = await stageEditor(platform);
    try {
      const pointer = await prepareEditorRelease({
        root: f.stage, candidate: f.candidate, releaseTag: tag, destination: f.destination,
      });
      assert.equal(pointer.outputRoot, path.join(f.stage, 'packages'));
      assert.deepEqual(pointer.artifacts, f.artifacts);
      assert.deepEqual(JSON.parse(await readFile(f.destination, 'utf8')), pointer);
      for (const entry of f.artifacts) {
        const bytes = await readFile(path.join(f.stage, 'packages', entry.fileName));
        assert.equal(sha(bytes), entry.sha256);
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test('Editor promotion rejects changed source tag, platform and source installer contents', async () => {
  const f = await stageEditor('linux');
  try {
    const args = { root: f.stage, candidate: f.candidate, releaseTag: tag, destination: f.destination };
    await assert.rejects(prepareEditorRelease({ ...args, releaseTag: 'v7.0.0' }), /tag mismatch/);
    await assert.rejects(prepareEditorRelease({
      ...args, candidate: { ...args.candidate, target: 'windows-x64-editor' },
    }), /linux.*windows|actual|platform|arch|mismatch/is);
    await writeFile(path.join(f.stage, 'packages', f.files[1]), 'tampered original');
    await assert.rejects(prepareEditorRelease(args), /size mismatch|SHA mismatch|Empty or invalid Editor installer/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Editor promotion fails closed on mismatched primary pointer or missing installer manifest entry', async () => {
  const f = await stageEditor('macos');
  const args = { root: f.stage, candidate: f.candidate, releaseTag: tag, destination: f.destination };
  try {
    await writeFile(path.join(f.stage, 'editor-package'), f.files[0] + '\n' + '0'.repeat(64) + '\n');
    await assert.rejects(prepareEditorRelease(args), /Primary installer pointer/);
    await writeFile(path.join(f.stage, 'editor-package'), f.files[0] + '\n' + f.artifacts[0].sha256 + '\n');
    await writeFile(path.join(f.stage, 'noveltea-candidate.json'), JSON.stringify({
      files: [{ path: 'packages/' + f.files[0], sha256: f.artifacts[0].sha256, size: f.artifacts[0].size }],
    }));
    await assert.rejects(prepareEditorRelease(args), /not included in the trusted candidate manifest/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
