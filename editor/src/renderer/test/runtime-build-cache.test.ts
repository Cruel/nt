import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { runNovelTeaCli } from '../../cli/application';
import type { NovelTeaCliNativeToolService } from '../../cli/native-tool-service';
import { createDefaultAuthoringRecord } from '../project/entity-operations';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { defaultTestData } from '../../shared/project-schema/authoring-tests';
import { projectWorkspaceFiles } from '../../shared/project-workspace';

const roots: string[] = [];

async function createProjectWorkspace(options: Readonly<{ assetPath?: string }> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'noveltea-runtime-cache-'));
  roots.push(root);
  const project = createAuthoringProject({ id: 'cache-test', name: 'Cache Test' });
  project.rooms.start = createDefaultAuthoringRecord(
    'rooms',
    'start',
  ) as (typeof project.rooms)['start'];
  project.entrypoint = { kind: 'room', id: 'start' };
  project.tests.smoke = { id: 'smoke', label: 'Smoke', data: defaultTestData('Smoke') };
  project.tests.secondary = {
    id: 'secondary',
    label: 'Secondary',
    data: defaultTestData('Secondary'),
  };
  if (options.assetPath)
    project.assets.unused = {
      id: 'unused',
      label: 'Unused image',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: options.assetPath,
        extension: '.png',
        imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      }),
    };
  for (const [relative, text] of Object.entries(projectWorkspaceFiles(project, project.editor))) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text, 'utf8');
  }
  if (options.assetPath) {
    const target = path.join(root, options.assetPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, new Uint8Array([1, 2, 3, 4]));
  }
  return root;
}

function nativeTools(projects: unknown[]): NovelTeaCliNativeToolService {
  return {
    async compileShaders() {
      return { ok: true, success: true, diagnostics: [], outputs: [] };
    },
    async runHeadlessTest(request) {
      projects.push((request as { project: unknown }).project);
      return { ok: true, success: true };
    },
    async runUiTest() {
      return { ok: true, success: true };
    },
    async exportPackage() {
      return { ok: true, success: true };
    },
    async validateFontCoverage() {
      return { ok: true, success: true, diagnostics: [] };
    },
    shaderc() {
      return 0;
    },
    texturec() {
      return 0;
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runCachedTest(root: string, tools: NovelTeaCliNativeToolService) {
  return runNovelTeaCli(['--json', 'test', 'run', 'smoke'], { cwd: root, nativeTools: tools });
}

function cacheStatus(result: Awaited<ReturnType<typeof runNovelTeaCli>>) {
  return result.envelope.runtimeCache as
    | {
        status: 'hit' | 'miss' | 'stale' | 'unusable';
        reason: string;
        testCatalogStatus?: 'hit' | 'miss' | 'stale' | 'unusable';
        testCatalogReason?: string;
        published?: boolean;
        publicationReason?: string;
      }
    | undefined;
}

async function currentGeneration(root: string) {
  return (await readFile(path.join(root, '.noveltea/cache/runtime/current'), 'utf8')).trim();
}

function generationPath(root: string, generation: string, file: string) {
  return path.join(root, '.noveltea/cache/runtime/generations', generation, file);
}

describe('persistent runtime build cache', () => {
  it('publishes on the first authored test run and reuses the unchanged compiled project', async () => {
    const root = await createProjectWorkspace();
    const projects: unknown[] = [];
    const tools = nativeTools(projects);

    const first = await runCachedTest(root, tools);
    const second = await runCachedTest(root, tools);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(cacheStatus(first)).toMatchObject({ status: 'miss', published: true });
    expect(cacheStatus(second)).toMatchObject({ status: 'hit', testCatalogStatus: 'hit' });
    expect(projects).toHaveLength(2);
    expect(projects[1]).toEqual(projects[0]);
  });

  it('invalidates when tracked input mtime or byte size changes', async () => {
    const root = await createProjectWorkspace();
    const tools = nativeTools([]);
    expect((await runCachedTest(root, tools)).exitCode).toBe(0);

    const projectJson = path.join(root, 'project.json');
    const before = await stat(projectJson);
    const moved = new Date(before.mtimeMs + 5000);
    await utimes(projectJson, moved, moved);
    const mtimeChanged = await runCachedTest(root, tools);
    expect(cacheStatus(mtimeChanged)).toMatchObject({
      status: 'stale',
      reason: 'input-metadata-changed',
      published: true,
    });

    await writeFile(projectJson, `${await readFile(projectJson, 'utf8')} `, 'utf8');
    const sizeChanged = await runCachedTest(root, tools);
    expect(cacheStatus(sizeChanged)).toMatchObject({
      status: 'stale',
      reason: 'workspace-source-revision-changed',
      published: true,
    });
  });

  it('refreshes the authored-test catalog while reusing the runtime artifact across a Test-only edit', async () => {
    const root = await createProjectWorkspace();
    const tools = nativeTools([]);
    expect((await runCachedTest(root, tools)).exitCode).toBe(0);
    const firstGeneration = await currentGeneration(root);
    const firstArtifact = await readFile(
      generationPath(root, firstGeneration, 'artifact.json'),
      'utf8',
    );

    const testFile = path.join(root, 'records/tests/smoke.json');
    const testRecord = JSON.parse(await readFile(testFile, 'utf8')) as Record<string, unknown>;
    testRecord.label = 'Renamed smoke test';
    await writeFile(testFile, `${JSON.stringify(testRecord, null, 2)}\n`, 'utf8');

    const result = await runCachedTest(root, tools);
    expect(result.exitCode).toBe(0);
    expect(cacheStatus(result)).toMatchObject({
      status: 'hit',
      testCatalogStatus: 'stale',
      testCatalogReason: 'test-source-revision-changed',
      published: true,
    });
    const secondGeneration = await currentGeneration(root);
    expect(secondGeneration).not.toBe(firstGeneration);
    expect(await readFile(generationPath(root, secondGeneration, 'artifact.json'), 'utf8')).toBe(
      firstArtifact,
    );
    expect(cacheStatus(await runCachedTest(root, tools))).toMatchObject({
      status: 'hit',
      testCatalogStatus: 'hit',
    });
  });

  it('publishes deterministic runnable and blocked catalog entries without executing a blocked test', async () => {
    const root = await createProjectWorkspace();
    const projects: unknown[] = [];
    const tools = nativeTools(projects);
    expect((await runCachedTest(root, tools)).exitCode).toBe(0);
    expect(projects).toHaveLength(1);

    const testFile = path.join(root, 'records/tests/smoke.json');
    const testRecord = JSON.parse(await readFile(testFile, 'utf8')) as {
      data: { steps: unknown[] };
    };
    testRecord.data.steps = [];
    await writeFile(testFile, `${JSON.stringify(testRecord, null, 2)}\n`, 'utf8');

    const blocked = await runCachedTest(root, tools);
    expect(blocked.exitCode).not.toBe(0);
    expect(cacheStatus(blocked)).toMatchObject({
      status: 'hit',
      testCatalogStatus: 'stale',
      published: true,
    });
    expect(projects).toHaveLength(1);

    const generation = await currentGeneration(root);
    const catalog = JSON.parse(
      await readFile(generationPath(root, generation, 'tests.json'), 'utf8'),
    ) as {
      schema: string;
      version: number;
      entries: Array<{
        id: string;
        status: string;
        runner?: string;
        spec?: unknown;
        diagnostics?: Array<{ path: string; message: string }>;
      }>;
    };
    expect(catalog).toMatchObject({ schema: 'noveltea.runtime-test-catalog', version: 1 });
    expect(catalog.entries.map((entry) => entry.id)).toEqual(['secondary', 'smoke']);
    expect(catalog.entries[0]).toMatchObject({
      id: 'secondary',
      status: 'runnable',
      runner: 'runtime',
      spec: { schema: 'noveltea.editor.playback', version: 1, id: 'secondary' },
    });
    expect(catalog.entries[1]).toMatchObject({
      id: 'smoke',
      status: 'blocked',
      diagnostics: [{ path: '/tests/smoke/data/steps' }],
    });
  });

  it('conservatively tracks plausible source additions and deletions but ignores README files', async () => {
    const root = await createProjectWorkspace();
    const tools = nativeTools([]);
    expect((await runCachedTest(root, tools)).exitCode).toBe(0);

    await writeFile(path.join(root, 'scripts/README.md'), '# local notes\n', 'utf8');
    expect(cacheStatus(await runCachedTest(root, tools))).toMatchObject({ status: 'hit' });

    const extra = path.join(root, 'scripts/helpers/extra.lua');
    await mkdir(path.dirname(extra), { recursive: true });
    await writeFile(extra, 'return {}\n', 'utf8');
    expect(cacheStatus(await runCachedTest(root, tools))).toMatchObject({
      status: 'stale',
      published: true,
    });
    expect(cacheStatus(await runCachedTest(root, tools))).toMatchObject({ status: 'hit' });

    await rm(extra);
    expect(cacheStatus(await runCachedTest(root, tools))).toMatchObject({
      status: 'stale',
      published: true,
    });
  });

  it('invalidates declared Asset sources outside the conventional Asset tree', async () => {
    const assetPath = 'images/custom/source.png';
    const root = await createProjectWorkspace({ assetPath });
    const tools = nativeTools([]);
    expect((await runCachedTest(root, tools)).exitCode).toBe(0);

    const asset = path.join(root, assetPath);
    const before = await stat(asset);
    await writeFile(asset, new Uint8Array([4, 3, 2, 1]));
    const moved = new Date(before.mtimeMs + 5000);
    await utimes(asset, moved, moved);
    const changed = await runCachedTest(root, tools);
    expect(cacheStatus(changed)).toMatchObject({
      status: 'stale',
      reason: 'input-metadata-changed',
      published: true,
    });

    await rm(asset);
    const missing = await runCachedTest(root, tools);
    expect(missing.exitCode).toBe(0);
    expect(cacheStatus(missing)).toMatchObject({
      status: 'unusable',
      reason: 'input-missing',
    });
  });

  it('ignores recent partial generations and cleans aged crash/concurrency orphans on publish', async () => {
    const root = await createProjectWorkspace();
    const tools = nativeTools([]);
    expect((await runCachedTest(root, tools)).exitCode).toBe(0);
    const published = await currentGeneration(root);
    const generations = path.join(root, '.noveltea/cache/runtime/generations');

    const partial = path.join(generations, '11111111-1111-4111-8111-111111111111');
    await mkdir(partial, { recursive: true });
    await writeFile(path.join(partial, 'artifact.json'), '{partial', 'utf8');

    const unchanged = await runCachedTest(root, tools);
    expect(unchanged.exitCode).toBe(0);
    expect(cacheStatus(unchanged)).toMatchObject({ status: 'hit' });
    expect(await currentGeneration(root)).toBe(published);
    await expect(stat(partial)).resolves.toBeDefined();

    const overwritten = path.join(generations, '22222222-2222-4222-8222-222222222222');
    await mkdir(overwritten, { recursive: true });
    const publishedMarker = path.join(overwritten, 'published');
    await writeFile(publishedMarker, 'published\n', 'utf8');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(partial, old, old);
    await utimes(publishedMarker, old, old);
    await utimes(overwritten, old, old);

    const projectJson = path.join(root, 'project.json');
    const before = await stat(projectJson);
    const moved = new Date(before.mtimeMs + 5000);
    await utimes(projectJson, moved, moved);
    const rebuilt = await runCachedTest(root, tools);
    expect(rebuilt.exitCode).toBe(0);
    expect(cacheStatus(rebuilt)).toMatchObject({ status: 'stale', published: true });
    await expect(stat(partial)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(overwritten)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves an aged generation owned by a live writer', async () => {
    const root = await createProjectWorkspace();
    const tools = nativeTools([]);
    expect((await runCachedTest(root, tools)).exitCode).toBe(0);

    const live = path.join(
      root,
      '.noveltea/cache/runtime/generations',
      '33333333-3333-4333-8333-333333333333',
    );
    await mkdir(live, { recursive: true });
    const writer = path.join(live, 'writer.json');
    await writeFile(
      writer,
      `${JSON.stringify({
        schema: 'noveltea.runtime-build-cache.writer',
        pid: process.pid,
        startedAtMs: Date.now() - 48 * 60 * 60 * 1000,
      })}\n`,
      'utf8',
    );
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(writer, old, old);
    await utimes(live, old, old);

    const projectJson = path.join(root, 'project.json');
    const before = await stat(projectJson);
    const moved = new Date(before.mtimeMs + 5000);
    await utimes(projectJson, moved, moved);
    expect((await runCachedTest(root, tools)).exitCode).toBe(0);
    await expect(stat(live)).resolves.toBeDefined();
  });

  it('rejects incompatible compiler identity and self-heals corrupt cached artifacts', async () => {
    const root = await createProjectWorkspace();
    const tools = nativeTools([]);
    expect((await runCachedTest(root, tools)).exitCode).toBe(0);

    const firstGeneration = await currentGeneration(root);
    const firstManifestPath = path.join(
      root,
      '.noveltea/cache/runtime/generations',
      firstGeneration,
      'manifest.json',
    );
    const manifest = JSON.parse(await readFile(firstManifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    manifest.compilerIdentity = 'incompatible-build';
    await writeFile(firstManifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
    const incompatible = await runCachedTest(root, tools);
    expect(cacheStatus(incompatible)).toMatchObject({
      status: 'stale',
      reason: 'compiler-identity-changed',
      published: true,
    });

    const repairedGeneration = await currentGeneration(root);
    await writeFile(
      path.join(root, '.noveltea/cache/runtime/generations', repairedGeneration, 'artifact.json'),
      '{broken',
      'utf8',
    );
    const corrupt = await runCachedTest(root, tools);
    expect(cacheStatus(corrupt)).toMatchObject({
      status: 'unusable',
      reason: 'artifact-digest-mismatch',
      published: true,
    });

    const digestGeneration = await currentGeneration(root);
    const artifactPath = path.join(
      root,
      '.noveltea/cache/runtime/generations',
      digestGeneration,
      'artifact.json',
    );
    const schemaValidArtifact = JSON.parse(await readFile(artifactPath, 'utf8')) as {
      compiledProject: { project: { name: string } };
    };
    schemaValidArtifact.compiledProject.project.name = 'Tampered but schema-valid';
    await writeFile(artifactPath, `${JSON.stringify(schemaValidArtifact)}\n`, 'utf8');
    const tampered = await runCachedTest(root, tools);
    expect(cacheStatus(tampered)).toMatchObject({
      status: 'unusable',
      reason: 'artifact-digest-mismatch',
      published: true,
    });
  });

  it('treats a non-regular plausible source as unusable rather than trusting the cache', async () => {
    const root = await createProjectWorkspace();
    const tools = nativeTools([]);
    expect((await runCachedTest(root, tools)).exitCode).toBe(0);

    await mkdir(path.join(root, 'scripts/not-a-file.lua'));
    const result = await runCachedTest(root, tools);
    expect(result.exitCode).toBe(0);
    expect(cacheStatus(result)).toMatchObject({
      status: 'unusable',
      reason: 'discovery-candidate-not-regular-file',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'fails closed when a plausible source is a symlink',
    async () => {
      const root = await createProjectWorkspace();
      const tools = nativeTools([]);
      expect((await runCachedTest(root, tools)).exitCode).toBe(0);

      await writeFile(path.join(root, 'outside.lua'), 'return {}\n', 'utf8');
      await symlink(path.join(root, 'outside.lua'), path.join(root, 'scripts/linked.lua'));
      const result = await runCachedTest(root, tools);
      expect(result.exitCode).toBe(0);
      expect(cacheStatus(result)).toMatchObject({
        status: 'unusable',
        reason: 'discovery-symlink',
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps playback successful and the previous generation current when publication fails',
    async () => {
      const root = await createProjectWorkspace();
      const tools = nativeTools([]);
      expect((await runCachedTest(root, tools)).exitCode).toBe(0);
      const previous = await currentGeneration(root);

      const generations = path.join(root, '.noveltea/cache/runtime/generations');
      const runtimeRoot = path.join(root, '.noveltea/cache/runtime');
      await chmod(generations, 0o500);
      await chmod(runtimeRoot, 0o500);
      try {
        const projectJson = path.join(root, 'project.json');
        const before = await stat(projectJson);
        const moved = new Date(before.mtimeMs + 5000);
        await utimes(projectJson, moved, moved);
        const result = await runCachedTest(root, tools);
        expect(result.exitCode).toBe(0);
        expect(cacheStatus(result)).toMatchObject({ status: 'stale', published: false });
        expect(await currentGeneration(root)).toBe(previous);
      } finally {
        await chmod(runtimeRoot, 0o700);
        await chmod(generations, 0o700);
      }
    },
  );

  it('keeps cache diagnostics out of normal human output', async () => {
    const root = await createProjectWorkspace();
    const result = await runNovelTeaCli(['test', 'run', 'smoke'], {
      cwd: root,
      nativeTools: nativeTools([]),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).not.toContain('cache');
    expect(result.stderr.toLowerCase()).not.toContain('cache');
  });
});
