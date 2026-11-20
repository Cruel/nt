import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { stageEditorCandidate } from '../../scripts/ci/stage-editor-candidate.mjs';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'nt-editor-candidate-'));
  roots.push(repo);
  const outputRoot = path.join(repo, 'editor/out/electron-builder/artifacts/producer');
  await mkdir(outputRoot, { recursive: true });
  const bytes = Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.alloc(50, 0x55)]);
  const files = ['NovelTea.AppImage', 'NovelTea.deb', 'NovelTea.rpm'];
  for (const name of files) await writeFile(path.join(outputRoot, name), bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const pointer = {
    mode: 'artifact', platform: 'linux', architecture: 'x64',
    releaseTag: 'dev-' + 'a'.repeat(40), outputRoot,
    artifacts: files.map((fileName) => ({ fileName, size: bytes.length, sha256 })),
  };
  const candidate = {
    id: 'linux-editor-x64', kind: 'editor-package', target: 'linux-x64-editor',
    root: 'build/ci-candidates/linux-editor-x64', executable: 'editor-package',
  };
  return { repoRoot: repo, candidate, pointer, releaseTag: pointer.releaseTag };
}

test('Editor candidate stages the exact verified multi-installer distribution set', async () => {
  const args = await setup();
  const dest = await stageEditorCandidate(args);
  const manifest = JSON.parse(await readFile(path.join(dest, 'editor-distribution.json')));
  assert.deepEqual(manifest.artifacts.map((entry) => entry.fileName).sort(),
    ['NovelTea.AppImage', 'NovelTea.deb', 'NovelTea.rpm'].sort());
  assert.equal(manifest.releaseTag, args.releaseTag);
  assert.equal((await readFile(path.join(dest, 'editor-package'))).length, 54);
  assert.equal((await readFile(path.join(dest, 'packages', 'NovelTea.deb'))).length, 54);
});

test('Editor candidate rejects tampering, missing installers, mismatched host and stale release', async () => {
  const args = await setup();
  await writeFile(path.join(args.pointer.outputRoot, 'NovelTea.rpm'), Buffer.alloc(54, 5));
  await assert.rejects(stageEditorCandidate(args), /SHA-256 mismatch/i);
  args.pointer.artifacts.splice(0, 1);
  await assert.rejects(stageEditorCandidate(args), /exact host distribution inventory/i);
  args.pointer.artifacts.push({ fileName: 'other.AppImage', size: 54, sha256: 'a'.repeat(64) });
  await assert.rejects(stageEditorCandidate(args), /ENOENT|SHA-256|size mismatch/i);
  args.pointer.platform = 'windows';
  await assert.rejects(stageEditorCandidate(args), /host or architecture/i);
  args.pointer.platform = 'linux';
  await assert.rejects(stageEditorCandidate({ ...args, releaseTag: 'dev-' + 'b'.repeat(40) }), /mode\/tag/i);
});

test('Editor artifact input must remain under the producer checkout, not an arbitrary external path', async () => {
  const args = await setup();
  args.pointer.outputRoot = path.dirname(args.repoRoot);
  await assert.rejects(stageEditorCandidate(args), /outside the source-owned/i);
});
