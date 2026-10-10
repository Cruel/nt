import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const picker = vi.hoisted(() => ({ files: [] as string[] }));
vi.mock('electron', () => ({
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: picker.files }) },
  shell: { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() },
}));

import {
  importProjectAttachmentFiles,
  inspectProjectAttachmentFile,
  listProjectAttachmentFiles,
  openProjectAttachmentFile,
} from '../../main/services/project-asset-attachment-service';
import {
  assetAttachmentPatches,
  attachmentUsages,
  projectAttachmentPaths,
} from '../../shared/project-schema/authoring-asset-attachments';
import {
  assetDataSchema,
  isSafeProjectAttachmentPath,
  parseAssetData,
} from '../../shared/project-schema/authoring-assets';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { applyJsonPatch } from '@/project/json-patch';
import { toJsonValue } from '@/project/json-value';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nt-attachment-'));
  roots.push(root);
  await mkdir(path.join(root, 'assets/images'), { recursive: true });
  await mkdir(path.join(root, 'support/references'), { recursive: true });
  const project = createAuthoringProject();
  for (const id of ['alpha', 'beta', 'gamma'])
    project.assets[id] = {
      id,
      label: id,
      data: {
        kind: 'binary',
        source: { type: 'project-file', path: `assets/images/${id}.bin` },
        aliases: [],
        imageMetadata: null,
      },
    };
  return { root, project };
}

afterEach(async () => {
  picker.files = [];
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('first-class Asset attachment contract', () => {
  const base = {
    kind: 'binary',
    source: { type: 'project-file', path: 'assets/a.bin' },
    aliases: [],
    imageMetadata: null,
  };
  it('accepts valid purposes and optional names, rejecting duplicate and nonportable paths', () => {
    const attachments = [
      {
        path: 'support/licenses/notice.txt',
        purpose: 'distribution-notice',
        displayName: 'Author License',
      },
      { path: 'support/sources/source.psd', purpose: 'authoring-source' },
      { path: 'support/references/ref.jpg', purpose: 'reference' },
      { path: 'support/other/data.zip', purpose: 'other' },
    ];
    expect(assetDataSchema.safeParse({ ...base, attachments }).success).toBe(true);
    expect(
      assetDataSchema.safeParse({ ...base, attachments: [...attachments, attachments[0]] }).success,
    ).toBe(false);
    for (const candidate of [
      '../escape.md',
      '/absolute.md',
      'C:/outside.md',
      'support/../escape.md',
      '.noveltea/secret.txt',
      'dist/bundle.txt',
      'node_modules/pkg.txt',
      'support\\file.txt',
    ])
      expect(isSafeProjectAttachmentPath(candidate)).toBe(false);
    expect(
      assetDataSchema.safeParse({
        ...base,
        attachments: [{ path: 'support/file.txt', purpose: 'license' }],
      }).success,
    ).toBe(false);
    expect(parseAssetData(base)?.attachments).toEqual([]);
  });

  it('provides atomic shared association, relink and undoable patch semantics', async () => {
    const { project } = await fixture();
    const notice = {
      path: 'support/licenses/license.txt',
      purpose: 'distribution-notice' as const,
    };
    const patches = assetAttachmentPatches(project, ['alpha', 'beta'], {
      kind: 'add',
      attachment: notice,
    });
    expect(patches).toHaveLength(2);
    const modified = applyJsonPatch(toJsonValue(project), patches).document;
    const changed = modified as unknown as typeof project;
    expect(attachmentUsages(changed, notice.path).map((usage) => usage.assetId)).toEqual([
      'alpha',
      'beta',
    ]);
    expect(projectAttachmentPaths(changed)).toEqual(['support/licenses/license.txt']);
    expect(projectAttachmentPaths(project)).toEqual([]);
    const before = toJsonValue(project);
    expect(before).not.toEqual(modified);
    expect(() =>
      assetAttachmentPatches(changed, ['alpha', 'gamma'], {
        kind: 'replace',
        attachment: { ...notice, path: 'support/new.txt' },
        priorPath: notice.path,
      }),
    ).toThrow(/not associated/);
    const changedPath = applyJsonPatch(
      modified,
      assetAttachmentPatches(changed, ['alpha', 'beta'], {
        kind: 'replace',
        attachment: { ...notice, path: 'support/new.txt' },
        priorPath: notice.path,
      }),
    ).document as unknown as typeof project;
    expect(projectAttachmentPaths(changedPath)).toEqual(['support/new.txt']);
    expect(
      assetAttachmentPatches(changed, ['alpha'], { kind: 'remove', attachment: notice }),
    ).toHaveLength(1);
  });

  it('records independent physical Asset baselines for a shared Authoring Source', async () => {
    const { project } = await fixture();
    const left = `sha256:${'1'.repeat(64)}`;
    const right = `sha256:${'2'.repeat(64)}`;
    const source = `sha256:${'a'.repeat(64)}`;
    project.assets.alpha.data.contentHash = left;
    project.assets.beta.data.contentHash = right;
    const changes = assetAttachmentPatches(
      project,
      ['alpha', 'beta'],
      {
        kind: 'add',
        attachment: {
          path: 'support/sources/portrait.psd',
          purpose: 'authoring-source',
          sourceBaselineHash: source,
        },
      },
      { alpha: left, beta: right },
    );
    const updated = applyJsonPatch(toJsonValue(project), changes)
      .document as unknown as typeof project;
    expect(parseAssetData(updated.assets.alpha.data)?.attachments).toEqual([
      expect.objectContaining({ sourceBaselineHash: source, assetBaselineHash: left }),
    ]);
    expect(parseAssetData(updated.assets.beta.data)?.attachments).toEqual([
      expect.objectContaining({ sourceBaselineHash: source, assetBaselineHash: right }),
    ]);
    expect(parseAssetData(project.assets.alpha.data)?.attachments).toEqual([]);
  });
});

describe('Project-owned attachment files', () => {
  it('validates complete Distribution Notice bytes before permitting import or association', async () => {
    const { root } = await fixture();
    const external = await mkdtemp(path.join(os.tmpdir(), 'nt-invalid-notice-'));
    roots.push(external);
    const invalid = path.join(external, 'notice.txt');
    for (const [contents, reason] of [
      [Buffer.from([0xff, 0xfe]), /UTF-8/],
      [Buffer.from('invalid\u0000notice'), /control/],
      [Buffer.alloc(1024 * 1024 + 1, 65), /1 MiB/],
    ] as const) {
      await writeFile(invalid, contents);
      picker.files = [invalid];
      const imported = await importProjectAttachmentFiles({} as never, root, {
        purpose: 'distribution-notice',
      });
      expect(imported.error).toMatch(reason);
      await mkdir(path.join(root, 'support/licenses'), { recursive: true });
      await writeFile(path.join(root, 'support/licenses/notice.txt'), contents);
      const inspected = await inspectProjectAttachmentFile(root, 'support/licenses/notice.txt');
      expect(inspected.noticeError).toMatch(reason);
    }
    await writeFile(invalid, 'Valid notice\n');
    const valid = await importProjectAttachmentFiles({} as never, root, {
      purpose: 'distribution-notice',
    });
    expect(valid.error).toBeUndefined();
  });
  it('lists Project-contained files and offers bounded inspection without entering excluded trees', async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, 'support/references/readme.md'), '# project notes');
    await mkdir(path.join(root, '.git'), { recursive: true });
    await writeFile(path.join(root, '.git/config'), 'secret');
    const files = await listProjectAttachmentFiles(root);
    expect(files.map((item) => item.path)).toEqual(['support/references/readme.md']);
    expect(await inspectProjectAttachmentFile(root, 'support/references/readme.md')).toMatchObject({
      exists: true,
      preview: '# project notes',
    });
    expect(await inspectProjectAttachmentFile(root, 'support/references/missing.md')).toMatchObject(
      { exists: false },
    );
    expect(await inspectProjectAttachmentFile(root, '../outside.txt')).toMatchObject({
      exists: false,
    });
  });

  it('imports a batch without overwrite, reuses byte-identical files, and honors purpose defaults', async () => {
    const { root } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'nt-import-source-'));
    roots.push(outside);
    const a = path.join(outside, 'notice.txt');
    const b = path.join(outside, 'another.md');
    await writeFile(a, 'first notice');
    await writeFile(b, '# second notice');
    await mkdir(path.join(root, 'support/licenses'), { recursive: true });
    await writeFile(path.join(root, 'support/licenses/notice.txt'), 'different existing data');
    picker.files = [a, b];
    const imported = await importProjectAttachmentFiles({} as never, root, {
      purpose: 'distribution-notice',
    });
    expect(imported).toMatchObject({
      paths: ['support/licenses/notice-2.txt', 'support/licenses/another.md'],
      reused: [],
    });
    expect(await readFile(path.join(root, 'support/licenses/notice.txt'), 'utf8')).toBe(
      'different existing data',
    );
    expect(await readFile(path.join(root, 'support/licenses/notice-2.txt'), 'utf8')).toBe(
      'first notice',
    );
    picker.files = [a];
    const reused = await importProjectAttachmentFiles({} as never, root, {
      purpose: 'distribution-notice',
      destinationDirectory: 'support/licenses',
    });
    expect(reused.reused).toEqual(['support/licenses/notice-2.txt']);
    expect(reused.paths).toEqual(['support/licenses/notice-2.txt']);
  });

  it('refuses symlink traversal and outside/occupied destinations without modifying physical files', async () => {
    const { root } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'nt-symlink-source-'));
    roots.push(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'external');
    await symlink(outside, path.join(root, 'support/other'), 'dir');
    expect((await inspectProjectAttachmentFile(root, 'support/other/secret.txt')).exists).toBe(
      false,
    );
    await expect(
      openProjectAttachmentFile(root, 'support/other/secret.txt', 'open'),
    ).rejects.toThrow(/symbolic links/);
    picker.files = [path.join(outside, 'secret.txt')];
    const unsafe = await importProjectAttachmentFiles({} as never, root, { purpose: 'other' });
    expect(unsafe.error).toMatch(/symbolic links/);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('external');
    const pathEscape = await importProjectAttachmentFiles({} as never, root, {
      purpose: 'reference',
      destinationDirectory: '../outside',
    });
    expect(pathEscape.error).toMatch(/inside the Project/);
  });
});
