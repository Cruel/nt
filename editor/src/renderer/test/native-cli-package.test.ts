import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vite-plus/test';
import { runNativeOnlyNovelTeaCli as runNovelTeaCli } from '../../cli/native-application';
import { parseNovelTeaCliGlobals } from '../../cli/bootstrap';
import { runNativeProjectPackageCli } from '../../cli/native-project-package-cli';
import type { NovelTeaCliNativeToolService } from '../../cli/native-tool-service';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { createLocalizedAssetVariant } from '../../shared/authoring-localized-assets';
import { logicalRuntimeArtifactPaths } from '../../shared/runtime-artifact-preparation';
import { createNodeProjectWorkspaceFileSystem } from '../../shared/project-workspace/node-project-workspace-file-system';
import { createDefaultAuthoringRecord } from '../project/entity-operations';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-package-'));
  roots.push(root);
  const yaml = 'malformed: [yaml\n';
  await writeFile(path.join(root, 'project.yaml'), yaml);
  const project = createAuthoringProject({ id: 'native-package', name: 'Native Package' });
  project.rooms.start = createDefaultAuthoringRecord(
    'rooms',
    'start',
  ) as typeof project.rooms.start;
  project.entrypoint = { kind: 'room', id: 'start' };
  const prepared = {
    project,
    sourceGeneration: `sha256:${'1'.repeat(64)}`,
    sourceRevisions: {
      'project.yaml': `sha256:${createHash('sha256').update(yaml).digest('hex')}`,
      'editor.yaml': 'absent',
      'traits.yaml': 'absent',
    },
    sourceOverlays: {},
    referencedAssetIds: [] as string[],
    cliDiagnostics: [],
  };
  return { root, project, prepared };
}

function packagePreparation<T extends { project: ReturnType<typeof createAuthoringProject> }>(
  prepared: T,
) {
  return {
    ok: true as const,
    ...prepared,
    runtimeIntent: 'runtime-package-export',
    profile: prepared.project.export.runtime,
    projectIdentity: prepared.project.project,
  };
}

function tools(
  writes: Array<{ outputPath: string; options: Record<string, unknown> }> = [],
  afterWrite?: () => void | Promise<void>,
): NovelTeaCliNativeToolService {
  return {
    async compileShaders() {
      return { ok: true, success: true, diagnostics: [], outputs: [] };
    },
    async runHeadlessTest() {
      throw new Error('Not used.');
    },
    async runUiTest() {
      throw new Error('Not used.');
    },
    async exportPackage(request) {
      const value = request as { outputPath: string; options: Record<string, unknown> };
      writes.push(value);
      await writeFile(value.outputPath, 'native-runtime-package');
      await afterWrite?.();
      return { ok: true, success: true, manifest: { format: 'noveltea.runtime-package' } };
    },
    shaderc() {
      return 0;
    },
    texturec() {
      return 0;
    },
  };
}

it('exports from native Runtime Package authority without TypeScript Project admission', async () => {
  const { root, prepared } = await fixture();
  const fileSystem = createNodeProjectWorkspaceFileSystem();
  const actions: string[] = [];
  const result = await runNovelTeaCli(
    ['--json', 'package', 'export', '--output', 'dist/game.ntpkg'],
    {
      cwd: root,
      fileSystem,
      nativeProjectCommands(request) {
        actions.push(String(request.action));
        return request.action === 'runtime-package-preparation'
          ? packagePreparation(prepared)
          : { ok: true };
      },
      nativeTools: tools(),
    },
  );

  expect(result.exitCode, JSON.stringify(result.envelope.diagnostics)).toBe(0);
  expect(await readFile(path.join(root, 'dist/game.ntpkg'), 'utf8')).toBe('native-runtime-package');
  expect(actions).toEqual([
    'runtime-package-preparation',
    'source-generation-proof',
    'source-generation-proof',
    'source-generation-proof',
  ]);
});

it('preserves the public missing-profile diagnostic after native admission', async () => {
  const { root, prepared } = await fixture();
  const result = await runNovelTeaCli(
    ['--json', 'package', 'export', '--output', 'dist/game.ntpkg', '--profile', 'missing-profile'],
    {
      cwd: root,
      fileSystem: createNodeProjectWorkspaceFileSystem(),
      nativeProjectCommands(request) {
        return request.action === 'runtime-package-preparation'
          ? packagePreparation(prepared)
          : { ok: true };
      },
      nativeTools: tools(),
    },
  );

  expect(result.exitCode).toBe(4);
  expect(result.envelope.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'export.profile_missing' }),
  );
});

it('uses only a pinned daemon generation and preserves developer package options', async () => {
  const { root, prepared } = await fixture();
  const writes: Array<{ outputPath: string; options: Record<string, unknown> }> = [];
  const result = await runNativeProjectPackageCli(
    parseNovelTeaCliGlobals([
      '--json',
      'package',
      'export',
      '--output',
      'game.ntpkg',
      '--include-unused-assets',
      '--include-shader-sources',
    ]),
    root,
    () => {
      throw new Error('Pinned worker attempted disk Project admission.');
    },
    tools(writes),
    {
      pinned: { projectRoot: root, preparation: prepared },
      pinnedExternalAssets: [],
      pinnedProjectTextSources: {},
      paths: logicalRuntimeArtifactPaths,
      fileSystem: createNodeProjectWorkspaceFileSystem(),
    },
  );

  expect(result?.exitCode).toBe(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.options).toMatchObject({ stripShaderSources: false });
});

it('rejects publication when the live Project advances during pinned package preparation', async () => {
  const { root, prepared } = await fixture();
  const result = await runNativeProjectPackageCli(
    parseNovelTeaCliGlobals(['--json', 'package', 'export', '--output', 'game.ntpkg']),
    root,
    () => {
      throw new Error('Pinned worker attempted disk Project admission.');
    },
    tools([], () => writeFile(path.join(root, 'project.yaml'), 'newer: owner-generation\n')),
    {
      pinned: { projectRoot: root, preparation: prepared },
      pinnedExternalAssets: [],
      pinnedProjectTextSources: {},
      paths: logicalRuntimeArtifactPaths,
      fileSystem: createNodeProjectWorkspaceFileSystem(),
    },
  );

  expect(result?.exitCode, JSON.stringify(result?.envelope.diagnostics)).toBe(4);
  expect(result?.envelope.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'export.pinned_input_changed' }),
  );
  await expect(readFile(path.join(root, 'game.ntpkg'), 'utf8')).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('uses native referenced-Asset closure and keeps the unused-Asset override scoped', async () => {
  const { root, project, prepared } = await fixture();
  await mkdir(path.join(root, 'assets'), { recursive: true });
  for (const id of ['used', 'unused']) {
    const relative = `assets/${id}.bin`;
    await writeFile(path.join(root, relative), id);
    project.assets[id] = {
      id,
      label: id,
      data: assetDataFromImportMetadata({
        kind: 'binary',
        projectRelativePath: relative,
        extension: '.bin',
        imageMetadata: null,
      }),
    };
    (prepared.sourceRevisions as Record<string, string>)[relative] = `sha256:${createHash('sha256')
      .update(id)
      .digest('hex')}`;
  }
  prepared.referencedAssetIds.push('used');
  const fileSystem = createNodeProjectWorkspaceFileSystem();
  const physical = await Promise.all(
    ['used', 'unused'].map(async (id) => {
      const relative = `assets/${id}.bin`;
      const revision = await fileSystem.readFileRevision(path.join(root, relative));
      return { path: relative, contentHash: revision.contentHash };
    }),
  );

  const run = async (args: string[]) => {
    const writes: Array<{ outputPath: string; options: Record<string, unknown> }> = [];
    const result = await runNativeProjectPackageCli(
      parseNovelTeaCliGlobals(['--json', 'package', 'export', ...args]),
      root,
      () => {
        throw new Error('Pinned worker attempted disk Project admission.');
      },
      tools(writes),
      {
        pinned: { projectRoot: root, preparation: prepared },
        pinnedExternalAssets: physical,
        pinnedProjectTextSources: {},
        paths: logicalRuntimeArtifactPaths,
        fileSystem,
      },
    );
    expect(result?.exitCode, JSON.stringify(result?.envelope.diagnostics)).toBe(0);
    return (writes[0]!.options.fileEntries as Array<{ packagePath: string }>).map(
      (entry) => entry.packagePath,
    );
  };

  expect(await run(['--output', 'pruned.ntpkg'])).toContain('assets/used.bin');
  expect(await run(['--output', 'pruned.ntpkg'])).not.toContain('assets/unused.bin');
  expect(await run(['--output', 'all.ntpkg', '--include-unused-assets'])).toEqual(
    expect.arrayContaining(['assets/used.bin', 'assets/unused.bin']),
  );
});

it('retains localized physical Asset and font closure outside the native base-Asset reference set', async () => {
  const { root, project, prepared } = await fixture();
  await mkdir(path.join(root, 'assets'), { recursive: true });
  const assets = [
    ['foyer', 'image', 'assets/foyer.png'],
    ['foyer-fr', 'image', 'assets/foyer-fr.png'],
    ['font-fr', 'font', 'assets/font-fr.ttf'],
  ] as const;
  for (const [id, kind, relative] of assets) {
    await writeFile(path.join(root, relative), id);
    project.assets[id] = {
      id,
      label: id,
      data: assetDataFromImportMetadata(
        kind === 'image'
          ? {
              kind,
              projectRelativePath: relative,
              extension: path.extname(relative),
              imageMetadata: { width: 8, height: 8, hasAlpha: true, orientation: 1 },
            }
          : {
              kind,
              projectRelativePath: relative,
              extension: path.extname(relative),
              imageMetadata: null,
            },
      ),
    };
    (prepared.sourceRevisions as Record<string, string>)[relative] = `sha256:${createHash('sha256')
      .update(id)
      .digest('hex')}`;
  }
  prepared.referencedAssetIds.push('foyer');
  project.localization.locales.fr = {
    supported: true,
    parentLocale: null,
    fontStack: [{ $ref: { collection: 'assets', id: 'font-fr' } }],
  };
  project.localization.assets.fr = {
    foyer: createLocalizedAssetVariant(project, 'foyer', 'foyer-fr', 'human')!,
  };
  project.export.runtime.localization = {
    locales: ['fr'],
    defaultLocale: 'fr',
    quality: 'development',
  };
  const fileSystem = createNodeProjectWorkspaceFileSystem();
  const physical = await Promise.all(
    assets.map(async ([, , relative]) => ({
      path: relative,
      contentHash: (await fileSystem.readFileRevision(path.join(root, relative))).contentHash,
    })),
  );
  const writes: Array<{ outputPath: string; options: Record<string, unknown> }> = [];
  const result = await runNativeProjectPackageCli(
    parseNovelTeaCliGlobals([
      '--json',
      'package',
      'export',
      '--output',
      'localized.ntpkg',
      '--allow-localization-warnings',
    ]),
    root,
    () => {
      throw new Error('Pinned worker attempted disk Project admission.');
    },
    tools(writes),
    {
      pinned: { projectRoot: root, preparation: prepared },
      pinnedExternalAssets: physical,
      pinnedProjectTextSources: {},
      paths: logicalRuntimeArtifactPaths,
      fileSystem,
    },
  );

  expect(result?.exitCode, JSON.stringify(result?.envelope.diagnostics)).toBe(0);
  const packagePaths = (writes[0]!.options.fileEntries as Array<{ packagePath: string }>).map(
    (entry) => entry.packagePath,
  );
  expect(packagePaths).toEqual(
    expect.arrayContaining(['assets/foyer-fr.png', 'assets/font-fr.ttf']),
  );
  expect(packagePaths).not.toContain('assets/foyer.png');
});

it('keeps localization warning acknowledgement scoped and never bypasses technical blockers', async () => {
  const { root, project, prepared } = await fixture();
  project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
  project.export.runtime.localization = {
    locales: ['fr'],
    defaultLocale: 'fr',
    quality: 'release',
  };
  const native = (request: Readonly<Record<string, unknown>>) =>
    request.action === 'runtime-package-preparation' ? packagePreparation(prepared) : { ok: true };
  const common = {
    pinnedExternalAssets: [] as const,
    pinnedProjectTextSources: {},
    paths: logicalRuntimeArtifactPaths,
    fileSystem: createNodeProjectWorkspaceFileSystem(),
  };
  const blocked = await runNativeProjectPackageCli(
    parseNovelTeaCliGlobals(['--json', 'package', 'export', '--output', 'blocked.ntpkg']),
    root,
    native,
    tools(),
    common,
  );
  expect(blocked?.exitCode, JSON.stringify(blocked?.envelope.diagnostics)).toBe(4);
  expect(blocked?.envelope.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'localization.export.warning_override_required' }),
  );

  const allowed = await runNativeProjectPackageCli(
    parseNovelTeaCliGlobals([
      '--json',
      'package',
      'export',
      '--output',
      'allowed.ntpkg',
      '--allow-localization-warnings',
    ]),
    root,
    native,
    tools(),
    common,
  );
  expect(allowed?.exitCode).toBe(0);

  project.entrypoint = null;
  const technical = await runNativeProjectPackageCli(
    parseNovelTeaCliGlobals([
      '--json',
      'package',
      'export',
      '--output',
      'technical.ntpkg',
      '--allow-localization-warnings',
    ]),
    root,
    native,
    tools(),
    common,
  );
  expect(technical?.exitCode).toBe(4);
  expect(technical?.envelope.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'runtime-package.entrypoint.required' }),
  );
});

it('rejects pinned Asset drift after package writing and preserves the previous output', async () => {
  const { root, project, prepared } = await fixture();
  const assetPath = path.join(root, 'assets/data.bin');
  await mkdir(path.dirname(assetPath), { recursive: true });
  await writeFile(assetPath, 'asset-v1');
  project.assets.data = {
    id: 'data',
    label: 'Data',
    data: assetDataFromImportMetadata({
      kind: 'binary',
      projectRelativePath: 'assets/data.bin',
      extension: '.bin',
      imageMetadata: null,
    }),
  };
  prepared.referencedAssetIds.push('data');
  const output = path.join(root, 'game.ntpkg');
  await writeFile(output, 'previous-package');
  const fileSystem = createNodeProjectWorkspaceFileSystem();
  const metadata = await fileSystem.readPathMetadata!(assetPath);
  const revision = await fileSystem.readFileRevision(assetPath);
  const result = await runNativeProjectPackageCli(
    parseNovelTeaCliGlobals(['--json', 'package', 'export', '--output', 'game.ntpkg']),
    root,
    () => {
      throw new Error('Pinned worker attempted disk Project admission.');
    },
    tools([], () => writeFile(assetPath, 'asset-v2')),
    {
      pinned: { projectRoot: root, preparation: prepared },
      pinnedExternalAssets: [
        {
          path: 'assets/data.bin',
          sourceIdentity: metadata.sourceIdentity,
          byteSize: revision.byteSize,
          mtimeNanoseconds: metadata.mtimeNanoseconds,
          contentHash: revision.contentHash,
        },
      ],
      pinnedProjectTextSources: {},
      paths: logicalRuntimeArtifactPaths,
      fileSystem,
    },
  );

  expect(result?.exitCode, JSON.stringify(result?.envelope.diagnostics)).toBe(4);
  expect(result?.envelope.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'export.pinned_input_changed' }),
  );
  expect(await readFile(output, 'utf8')).toBe('previous-package');
});

it('rejects local physical input drift after native admission without running the writer', async () => {
  const { root, project, prepared } = await fixture();
  const assetPath = path.join(root, 'assets/data.bin');
  await mkdir(path.dirname(assetPath), { recursive: true });
  await writeFile(assetPath, 'asset-v1');
  project.assets.data = {
    id: 'data',
    label: 'Data',
    data: assetDataFromImportMetadata({
      kind: 'binary',
      projectRelativePath: 'assets/data.bin',
      extension: '.bin',
      imageMetadata: null,
    }),
  };
  prepared.referencedAssetIds.push('data');
  (prepared.sourceRevisions as Record<string, string>)['assets/data.bin'] = `sha256:${createHash(
    'sha256',
  )
    .update('asset-v1')
    .digest('hex')}`;
  const writes: Array<{ outputPath: string; options: Record<string, unknown> }> = [];
  const result = await runNativeProjectPackageCli(
    parseNovelTeaCliGlobals(['--json', 'package', 'export', '--output', 'game.ntpkg']),
    root,
    async (request) => {
      if (request.action === 'runtime-package-preparation') {
        await writeFile(assetPath, 'asset-v2');
        return packagePreparation(prepared);
      }
      return { ok: true };
    },
    tools(writes),
    { fileSystem: createNodeProjectWorkspaceFileSystem() },
  );

  expect(result?.exitCode).toBe(4);
  expect(result?.envelope.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'export.pinned_input_changed' }),
  );
  expect(writes).toHaveLength(0);
});

it('rejects symlink output replacement without touching its target', async () => {
  const { root, prepared } = await fixture();
  const target = path.join(root, 'target.ntpkg');
  const output = path.join(root, 'game.ntpkg');
  await writeFile(target, 'outside-target');
  await symlink(target, output);
  const result = await runNativeProjectPackageCli(
    parseNovelTeaCliGlobals(['--json', 'package', 'export', '--output', 'game.ntpkg']),
    root,
    () => {
      throw new Error('Pinned worker attempted disk Project admission.');
    },
    tools(),
    {
      pinned: { projectRoot: root, preparation: prepared },
      pinnedExternalAssets: [],
      pinnedProjectTextSources: {},
      paths: logicalRuntimeArtifactPaths,
      fileSystem: createNodeProjectWorkspaceFileSystem(),
    },
  );

  expect(result?.exitCode).toBe(4);
  expect(result?.envelope.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'export.output_invalid' }),
  );
  expect(await readFile(target, 'utf8')).toBe('outside-target');
});

it('rejects a non-file output collision without replacing the existing path', async () => {
  const { root, prepared } = await fixture();
  const output = path.join(root, 'game.ntpkg');
  await mkdir(output);
  const result = await runNativeProjectPackageCli(
    parseNovelTeaCliGlobals(['--json', 'package', 'export', '--output', 'game.ntpkg']),
    root,
    () => {
      throw new Error('Pinned worker attempted disk Project admission.');
    },
    tools(),
    {
      pinned: { projectRoot: root, preparation: prepared },
      pinnedExternalAssets: [],
      pinnedProjectTextSources: {},
      paths: logicalRuntimeArtifactPaths,
      fileSystem: createNodeProjectWorkspaceFileSystem(),
    },
  );

  expect(result?.exitCode).toBe(4);
  expect(result?.envelope.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'export.output_invalid' }),
  );
  expect((await stat(output)).isDirectory()).toBe(true);
});

it('does not publish a package when cancellation arrives after native package writing', async () => {
  const { root, prepared } = await fixture();
  const output = path.join(root, 'game.ntpkg');
  await writeFile(output, 'previous-package');
  const controller = new AbortController();
  const result = await runNativeProjectPackageCli(
    parseNovelTeaCliGlobals(['--json', 'package', 'export', '--output', 'game.ntpkg']),
    root,
    () => {
      throw new Error('Pinned worker attempted disk Project admission.');
    },
    tools([], () => controller.abort()),
    {
      pinned: { projectRoot: root, preparation: prepared },
      pinnedExternalAssets: [],
      pinnedProjectTextSources: {},
      paths: logicalRuntimeArtifactPaths,
      fileSystem: createNodeProjectWorkspaceFileSystem(),
      abortSignal: controller.signal,
    },
  );

  expect(result?.exitCode).toBe(4);
  expect(result?.envelope.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'export.cancelled', severity: 'warning' }),
  );
  expect(await readFile(output, 'utf8')).toBe('previous-package');
});

it('keeps the previous package when the native package writer fails', async () => {
  const { root, prepared } = await fixture();
  const output = path.join(root, 'game.ntpkg');
  await writeFile(output, 'previous-package');
  const nativeTools = {
    ...tools(),
    async exportPackage(request: unknown) {
      await writeFile((request as { outputPath: string }).outputPath, 'incomplete-package');
      return { ok: false, error: 'simulated package writer failure' };
    },
  };
  const result = await runNativeProjectPackageCli(
    parseNovelTeaCliGlobals(['--json', 'package', 'export', '--output', 'game.ntpkg']),
    root,
    () => {
      throw new Error('Pinned worker attempted disk Project admission.');
    },
    nativeTools,
    {
      pinned: { projectRoot: root, preparation: prepared },
      pinnedExternalAssets: [],
      pinnedProjectTextSources: {},
      paths: logicalRuntimeArtifactPaths,
      fileSystem: createNodeProjectWorkspaceFileSystem(),
    },
  );

  expect(result?.exitCode).toBe(6);
  expect(result?.envelope.diagnostics).toContainEqual(
    expect.objectContaining({
      code: 'native.operation',
      message: 'simulated package writer failure',
    }),
  );
  expect(await readFile(output, 'utf8')).toBe('previous-package');
});

it('rolls back an interrupted transactional publication to the previous package', async () => {
  const { root, prepared } = await fixture();
  const output = path.join(root, 'game.ntpkg');
  await writeFile(output, 'previous-package');
  const base = createNodeProjectWorkspaceFileSystem();
  let rejectedStageMove = false;
  const fileSystem = new Proxy(base, {
    get(target, property, receiver) {
      if (property === 'movePathAtomic')
        return async (from: string, to: string) => {
          if (!rejectedStageMove && from.includes('.tmp-') && to === output) {
            rejectedStageMove = true;
            throw new Error('simulated publication interruption');
          }
          return target.movePathAtomic(from, to);
        };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const result = await runNativeProjectPackageCli(
    parseNovelTeaCliGlobals(['--json', 'package', 'export', '--output', 'game.ntpkg']),
    root,
    () => {
      throw new Error('Pinned worker attempted disk Project admission.');
    },
    tools(),
    {
      pinned: { projectRoot: root, preparation: prepared },
      pinnedExternalAssets: [],
      pinnedProjectTextSources: {},
      paths: logicalRuntimeArtifactPaths,
      fileSystem,
    },
  );

  expect(result?.exitCode).toBe(4);
  expect(result?.envelope.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'export.publish_failed' }),
  );
  expect(await readFile(output, 'utf8')).toBe('previous-package');
});
