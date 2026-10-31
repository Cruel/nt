import { afterEach, describe, expect, it } from 'vite-plus/test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { planNativeProjectSourceTransaction as plan } from '../../main/services/native-project-source-transactions';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'nt-native-source-plan-'));
  roots.push(root);
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'shaders'), { recursive: true });
  await mkdir(path.join(root, 'support'), { recursive: true });
  await mkdir(path.join(root, 'assets'), { recursive: true });
  return { root, project: createAuthoringProject() };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
// This planner test injects an identity oracle; native bridge parity is tested separately.
const digest = (text: string): `xxh3-128:${string}` =>
  `xxh3-128:${createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
const planNativeProjectSourceTransaction: typeof plan = (
  root,
  project,
  operation,
  expected,
  admitted,
  revisionFor,
) =>
  plan(
    root,
    project,
    operation,
    expected,
    admitted,
    revisionFor ?? ((bytes) => digest(Buffer.from(bytes).toString('utf8'))),
  );

describe('native Project source transaction planning (no TypeScript authoring writes)', () => {
  it('accepts canonical preconditions and rejects retired SHA-256 or stale source bytes', async () => {
    const { root, project } = await fixture();
    const file = 'scripts/helper.lua';
    await writeFile(path.join(root, file), 'abc');
    const nativeRevision = 'xxh3-128:06b05ab6733a618578af5f94892f3950' as const;
    const sourceRevision = (bytes: Uint8Array) =>
      Buffer.from(bytes).toString('utf8') === 'abc' ? nativeRevision : `xxh3-128:${'0'.repeat(32)}`;
    const move = { kind: 'move' as const, fromPath: file, toPath: 'scripts/renamed.lua' };
    const planned = await planNativeProjectSourceTransaction(
      root,
      project,
      move,
      { [file]: nativeRevision },
      {},
      sourceRevision,
    );
    expect(planned.transition).toMatchObject({
      kind: 'source-files',
      files: expect.arrayContaining([
        expect.objectContaining({ path: file, expectedRevision: nativeRevision, contents: null }),
      ]),
    });
    await expect(
      planNativeProjectSourceTransaction(
        root,
        project,
        move,
        { [file]: ('sha256:' + '0'.repeat(64)) as never },
        {},
        sourceRevision,
      ),
    ).rejects.toThrow('WORKSPACE_REVISION_CONFLICT');
    await writeFile(path.join(root, file), 'external mutation');
    for (const expected of [nativeRevision, digest('abc')]) {
      await expect(
        planNativeProjectSourceTransaction(
          root,
          project,
          move,
          { [file]: expected },
          {},
          sourceRevision,
        ),
      ).rejects.toThrow('WORKSPACE_REVISION_CONFLICT');
    }
    await expect(readFile(path.join(root, file), 'utf8')).resolves.toBe('external mutation');
    await expect(readFile(path.join(root, 'scripts/renamed.lua'))).rejects.toThrow();
  });
  it('creates source files only as exact-revision native journal targets', async () => {
    const { root, project } = await fixture();
    const created = await planNativeProjectSourceTransaction(
      root,
      project,
      { kind: 'create-file', path: 'scripts/main.lua', fileKind: 'lua' },
      {},
      {},
    );
    expect(created.transition).toEqual({
      kind: 'source-files',
      files: [
        {
          path: 'scripts/main.lua',
          expectedRevision: 'absent',
          contents: '-- NovelTea Lua source\n',
        },
      ],
    });
    expect(created.response.createdSourceIds).toEqual(['scripts/main.lua']);
    await expect(readFile(path.join(root, 'scripts/main.lua'))).rejects.toThrow();
    await expect(
      planNativeProjectSourceTransaction(
        root,
        project,
        { kind: 'create-file', path: 'shaders/misleading.lua', fileKind: 'lua' },
        {},
        {},
      ),
    ).rejects.toThrow('Invalid Project source');
  });

  it('plans native cleanup of source folders after their files relocate', async () => {
    const { root, project } = await fixture();
    await mkdir(path.join(root, 'scripts', 'library'), { recursive: true });
    await writeFile(path.join(root, 'scripts', 'library', 'helpers.lua'), 'return 5\n');
    const moved = await planNativeProjectSourceTransaction(
      root,
      project,
      { kind: 'move', fromPath: 'scripts/library', toPath: 'scripts/reusable' },
      {},
      {},
    );
    expect(moved.response.success).toBe(true);
    expect(moved.cleanupDirectories).toEqual(['scripts/library']);
    expect(moved.transition).toMatchObject({
      kind: 'source-files',
      files: expect.arrayContaining([
        expect.objectContaining({ path: 'scripts/library/helpers.lua', contents: null }),
        expect.objectContaining({
          path: 'scripts/reusable/helpers.lua',
          expectedRevision: 'absent',
        }),
      ]),
    });
    await expect(
      readFile(path.join(root, 'scripts', 'library', 'helpers.lua'), 'utf8'),
    ).resolves.toBe('return 5\n');
  });

  it('moves shader sources and rewrites Material references and include paths atomically', async () => {
    const { root, project } = await fixture();
    const shader = '#include "common.sc"\nvoid main() {}\n';
    await writeFile(path.join(root, 'shaders', 'effect.sc'), shader);
    await writeFile(path.join(root, 'shaders', 'common.sc'), '// shared\n');
    project.materials.paint = {
      id: 'paint',
      label: 'Paint',
      data: {
        ...defaultMaterialData('Paint'),
        shader: { fragment: { kind: 'project', path: 'shaders/effect.sc' } },
      },
    };
    const plan = await planNativeProjectSourceTransaction(
      root,
      project,
      { kind: 'move', fromPath: 'shaders/effect.sc', toPath: 'shaders/other/effect.sc' },
      { 'shaders/effect.sc': digest(shader) },
      {},
    );
    expect(plan.transition).toMatchObject({
      kind: 'source-files',
      files: expect.arrayContaining([
        { path: 'shaders/effect.sc', expectedRevision: digest(shader), contents: null },
        {
          path: 'shaders/other/effect.sc',
          expectedRevision: 'absent',
          contents: '#include "../common.sc"\nvoid main() {}\n',
        },
      ]),
    });
    expect(plan.patches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining('/materials/paint/data/shader') }),
      ]),
    );
    expect(plan.savePaths).toHaveProperty('materials/paint');
    expect(plan.response.pathRemap).toEqual({
      'shaders/effect.sc': 'shaders/other/effect.sc',
    });
    await expect(
      planNativeProjectSourceTransaction(
        root,
        project,
        { kind: 'move', fromPath: 'shaders/effect.sc', toPath: 'shaders/new.sc' },
        { 'shaders/effect.sc': digest('stale') },
        {},
      ),
    ).rejects.toThrow('WORKSPACE_REVISION_CONFLICT');
  });

  it('moves support files in either direction with their Asset references', async () => {
    const { root, project } = await fixture();
    await writeFile(path.join(root, 'support', 'license.txt'), 'LICENSE');
    project.assets.cover = {
      id: 'cover',
      label: 'Cover',
      data: {
        kind: 'binary',
        source: { type: 'project-file', path: 'assets/cover.png' },
        aliases: [],
        imageMetadata: null,
        attachments: [{ path: 'support/license.txt', purpose: 'distribution-notice' }],
      },
    };
    const plan = await planNativeProjectSourceTransaction(
      root,
      project,
      { kind: 'move-attachment', fromPath: 'support/license.txt', toPath: 'assets/license.txt' },
      {},
      {},
    );
    expect(plan.transition).toEqual({
      kind: 'move',
      moves: [{ fromPath: 'support/license.txt', toPath: 'assets/license.txt' }],
    });
    expect(plan.response.pathRemap).toEqual({
      'support/license.txt': 'assets/license.txt',
    });
    expect(plan.savePaths).toHaveProperty('assets/cover');
    expect(plan.patches).toContainEqual(
      expect.objectContaining({ path: expect.stringContaining('/assets/cover/data/attachments') }),
    );
  });

  it('refuses to delete referenced files without publishing a journal operation', async () => {
    const { root, project } = await fixture();
    await writeFile(path.join(root, 'shaders', 'effect.sc'), 'void main() {}');
    project.materials.paint = {
      id: 'paint',
      label: 'Paint',
      data: {
        ...defaultMaterialData('Paint'),
        shader: { fragment: { kind: 'project', path: 'shaders/effect.sc' } },
      },
    };
    const plan = await planNativeProjectSourceTransaction(
      root,
      project,
      { kind: 'delete', path: 'shaders/effect.sc' },
      {},
      {},
    );
    expect(plan.response.success).toBe(false);
    expect(plan.response.usages).toEqual([
      expect.objectContaining({ kind: 'material-shader', owner: 'materials/paint' }),
    ]);
    expect(plan.transition).toBeNull();
  });

  it('never reads or relocates a symlinked source outside the admitted Project', async () => {
    const { root, project } = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'nt-native-source-outside-'));
    roots.push(outside);
    await writeFile(path.join(outside, 'private.lua'), 'private source');
    await symlink(path.join(outside, 'private.lua'), path.join(root, 'scripts', 'linked.lua'));
    await expect(
      planNativeProjectSourceTransaction(
        root,
        project,
        { kind: 'move', fromPath: 'scripts/linked.lua', toPath: 'scripts/public.lua' },
        {},
        {},
      ),
    ).rejects.toThrow('symbolic link');
    await expect(readFile(path.join(root, 'scripts', 'public.lua'))).rejects.toThrow();
  });

  it('rejects symlinked and traversal shader-copy sources before creating a native plan', async () => {
    const { root, project } = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'nt-native-shader-outside-'));
    roots.push(outside);
    await writeFile(path.join(outside, 'private.sc'), 'private shader');
    await symlink(path.join(outside, 'private.sc'), path.join(root, 'shaders', 'linked.sc'));
    project.materials.paint = {
      id: 'paint',
      label: 'Paint',
      data: defaultMaterialData('Paint'),
    };
    for (const sourceIdentity of [
      'project:/shaders/linked.sc',
      'project:/shaders/../support/secret.sc',
    ]) {
      await expect(
        planNativeProjectSourceTransaction(
          root,
          project,
          { kind: 'material-shader-copy', materialId: 'paint', stage: 'fragment', sourceIdentity },
          {},
          {},
        ),
      ).rejects.toThrow();
    }
    expect(project.materials.paint.data).toEqual(defaultMaterialData('Paint'));
  });
});
