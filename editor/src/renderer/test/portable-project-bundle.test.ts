import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { runNovelTeaCli } from '../../cli/application';
import { importDesktopProject } from '../../main/services/desktop-project-import-service';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noveltea-ntproject-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function centralEntry(
  buffer: Buffer,
  name: string,
): { central: number; local: number; size: number } {
  let cursor = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (cursor >= 0) {
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const entryName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (entryName === name)
      return {
        central: cursor,
        local: buffer.readUInt32LE(cursor + 42),
        size: buffer.readUInt32LE(cursor + 24),
      };
    cursor = buffer.indexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      cursor + 46 + nameLength + extraLength + commentLength,
    );
  }
  throw new Error(`ZIP entry '${name}' not found.`);
}

function storedEntryText(input: Buffer, name: string): string {
  const entry = centralEntry(input, name);
  const localNameLength = input.readUInt16LE(entry.local + 26);
  const localExtraLength = input.readUInt16LE(entry.local + 28);
  const dataStart = entry.local + 30 + localNameLength + localExtraLength;
  return input.subarray(dataStart, dataStart + entry.size).toString('utf8');
}

function patchStoredEntryData(
  input: Buffer,
  name: string,
  mutate: (text: string) => string,
): Buffer {
  const output = Buffer.from(input);
  const entry = centralEntry(output, name);
  const localNameLength = output.readUInt16LE(entry.local + 26);
  const localExtraLength = output.readUInt16LE(entry.local + 28);
  const dataStart = entry.local + 30 + localNameLength + localExtraLength;
  const current = output.subarray(dataStart, dataStart + entry.size).toString('utf8');
  const replacement = Buffer.from(mutate(current), 'utf8');
  if (replacement.length !== entry.size)
    throw new Error('ZIP test patch must preserve entry size.');
  replacement.copy(output, dataStart);
  const crc = crc32(replacement);
  output.writeUInt32LE(crc, entry.central + 16);
  output.writeUInt32LE(crc, dataStart + entry.size + 4);
  return output;
}

function patchEntryPath(input: Buffer, name: string, replacement: string): Buffer {
  const output = Buffer.from(input);
  const entry = centralEntry(output, name);
  const original = Buffer.from(name, 'utf8');
  const next = Buffer.from(replacement, 'utf8');
  if (original.length !== next.length)
    throw new Error('ZIP test path patch must preserve path size.');
  next.copy(output, entry.central + 46);
  next.copy(output, entry.local + 30);
  return output;
}

async function createPortableFixture(root: string): Promise<{
  projectRoot: string;
  bundlePath: string;
}> {
  const projectRoot = path.join(root, 'source project');
  const created = await runNovelTeaCli(
    ['project', 'create', projectRoot, '--name', 'Portable Tea'],
    {
      cwd: root,
    },
  );
  expect(created.exitCode).toBe(0);
  const roomCreated = await runNovelTeaCli(
    ['--project', projectRoot, 'entity', 'create', 'rooms', 'start'],
    { cwd: root },
  );
  expect(roomCreated.exitCode).toBe(0);
  const projectManifestPath = path.join(projectRoot, 'project.json');
  const projectManifest = JSON.parse(await fs.readFile(projectManifestPath, 'utf8')) as Record<
    string,
    unknown
  >;
  projectManifest.entrypoint = { kind: 'room', id: 'start' };
  await fs.writeFile(projectManifestPath, `${JSON.stringify(projectManifest, null, 2)}\n`, 'utf8');

  const externalAsset = path.join(root, 'chapter-notes.txt');
  await fs.writeFile(externalAsset, 'portable authoring asset\n', 'utf8');
  const importedAsset = await runNovelTeaCli(
    ['--project', projectRoot, 'asset', 'import', externalAsset],
    { cwd: root },
  );
  expect(importedAsset.exitCode).toBe(0);

  await fs.mkdir(path.join(projectRoot, 'workflows', 'image'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, 'workflows', 'image', 'manifest.json'),
    '{"id":"portable-workflow"}\n',
    'utf8',
  );
  await fs.mkdir(path.join(projectRoot, 'workflows', 'image', '.git'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, 'workflows', 'image', '.git', 'config'),
    'exclude me\n',
    'utf8',
  );
  await fs.mkdir(path.join(projectRoot, 'dist'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'dist', 'generated.txt'), 'exclude me\n', 'utf8');
  await fs.mkdir(path.join(projectRoot, '.noveltea', 'editor'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, '.noveltea', 'editor', 'state.tmp'),
    'exclude me\n',
    'utf8',
  );
  await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, '.git', 'config'), 'exclude me\n', 'utf8');

  const bundlePath = path.join(root, 'portable.ntproject');
  const exported = await runNovelTeaCli(
    ['--project', projectRoot, '--json', 'project', 'export', '--output', bundlePath],
    { cwd: root },
  );
  expect(exported.exitCode).toBe(0);
  expect(JSON.parse(exported.stdout)).toMatchObject({
    success: true,
    bundleSchema: 'noveltea.project.bundle',
    bundleVersion: 1,
  });
  return { projectRoot, bundlePath };
}

describe('portable .ntproject Project bundle', () => {
  it('imports a desktop handoff into the confirmed destination and applies the confirmed Project name', async () => {
    const root = await tempRoot();
    const { bundlePath } = await createPortableFixture(root);
    const destination = path.join(root, 'renamed-import');

    const result = await importDesktopProject({
      request: {
        source: { kind: 'local', bundlePath },
        suggestedName: 'Portable Fixture',
      },
      projectName: 'Renamed Import',
      destination,
    });

    expect(result).toMatchObject({ success: true, projectPath: destination });
    const projectManifest = JSON.parse(
      await fs.readFile(path.join(destination, 'project.json'), 'utf8'),
    );
    expect(projectManifest.project.name).toBe('Renamed Import');
  });

  it('downloads, verifies, validates, and imports a remote desktop handoff', async () => {
    const root = await tempRoot();
    const { bundlePath } = await createPortableFixture(root);
    const bytes = await fs.readFile(bundlePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(bytes, {
          status: 200,
          headers: { 'content-length': String(bytes.byteLength) },
        }),
      ),
    );
    const destination = path.join(root, 'remote-import');

    const result = await importDesktopProject({
      request: {
        source: {
          kind: 'remote',
          url: 'https://assets.noveltea.dev/examples/fixture.ntproject',
          sha256,
        },
        suggestedName: 'Fixture',
      },
      projectName: 'Remote Fixture',
      destination,
    });

    expect(result).toMatchObject({ success: true, projectPath: destination });
    const projectManifest = JSON.parse(
      await fs.readFile(path.join(destination, 'project.json'), 'utf8'),
    );
    expect(projectManifest.project.name).toBe('Remote Fixture');
  });

  it('rejects a remote desktop handoff when the downloaded bytes do not match the expected SHA-256', async () => {
    const root = await tempRoot();
    const { bundlePath } = await createPortableFixture(root);
    const bytes = await fs.readFile(bundlePath);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes, { status: 200 })));
    const destination = path.join(root, 'remote-import');

    const result = await importDesktopProject({
      request: {
        source: {
          kind: 'remote',
          url: 'https://assets.noveltea.dev/examples/fixture.ntproject',
          sha256: '0'.repeat(64),
        },
        suggestedName: 'Fixture',
      },
      projectName: 'Fixture',
      destination,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('SHA-256');
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('round-trips a deterministic clean Project Workspace and validates the imported project', async () => {
    const root = await tempRoot();
    const { projectRoot, bundlePath } = await createPortableFixture(root);
    const secondBundle = path.join(root, 'portable-again.ntproject');
    const secondExport = await runNovelTeaCli(
      ['--project', projectRoot, 'project', 'export', '--output', secondBundle],
      { cwd: root },
    );
    expect(secondExport.exitCode).toBe(0);
    expect(await fs.readFile(secondBundle)).toEqual(await fs.readFile(bundlePath));

    const destination = path.join(root, 'fresh destination');
    const imported = await runNovelTeaCli(
      ['--json', 'project', 'import', bundlePath, destination],
      { cwd: root },
    );
    expect(imported.exitCode, imported.stdout || imported.stderr).toBe(0);
    expect(JSON.parse(imported.stdout)).toMatchObject({
      success: true,
      projectRoot: destination,
      bundleSchema: 'noveltea.project.bundle',
      bundleVersion: 1,
    });

    const validated = await runNovelTeaCli(['--project', destination, 'validate'], { cwd: root });
    expect(validated.exitCode, validated.stdout || validated.stderr).toBe(0);
    expect(await fs.readFile(path.join(destination, 'project.json'), 'utf8')).toBe(
      await fs.readFile(path.join(projectRoot, 'project.json'), 'utf8'),
    );
    expect(
      await fs.readFile(path.join(destination, 'workflows', 'image', 'manifest.json'), 'utf8'),
    ).toBe('{"id":"portable-workflow"}\n');
    await expect(
      fs.stat(path.join(destination, 'workflows', 'image', '.git')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(destination, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(destination, '.noveltea'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(path.join(destination, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects destination conflicts, unsupported versions, and unsafe archive paths without activation', async () => {
    const root = await tempRoot();
    const { bundlePath } = await createPortableFixture(root);
    const bundleBytes = await fs.readFile(bundlePath);

    const occupied = path.join(root, 'occupied');
    await fs.mkdir(occupied);
    const conflict = await runNovelTeaCli(['project', 'import', bundlePath, occupied], {
      cwd: root,
    });
    expect(conflict.exitCode).toBe(5);
    expect(conflict.stderr).toContain('already exists');

    const unsupportedPath = path.join(root, 'unsupported.ntproject');
    const unsupported = patchStoredEntryData(bundleBytes, 'ntproject.json', (text) =>
      text.replace('"version": 1', '"version": 2'),
    );
    await fs.writeFile(unsupportedPath, unsupported);
    const unsupportedDestination = path.join(root, 'unsupported-project');
    const unsupportedResult = await runNovelTeaCli(
      ['--json', 'project', 'import', unsupportedPath, unsupportedDestination],
      { cwd: root },
    );
    expect(unsupportedResult.exitCode).toBe(4);
    expect(JSON.parse(unsupportedResult.stdout)).toMatchObject({
      success: false,
      diagnostics: [{ code: 'PROJECT_BUNDLE_INVALID' }],
    });
    await expect(fs.stat(unsupportedDestination)).rejects.toMatchObject({ code: 'ENOENT' });

    const malformedPath = path.join(root, 'malformed.ntproject');
    await fs.writeFile(
      malformedPath,
      patchStoredEntryData(bundleBytes, 'ntproject.json', (text) => `[${text.slice(1)}`),
    );
    const malformedDestination = path.join(root, 'malformed-project');
    const malformedResult = await runNovelTeaCli(
      ['--json', 'project', 'import', malformedPath, malformedDestination],
      { cwd: root },
    );
    expect(malformedResult.exitCode).toBe(4);
    expect(JSON.parse(malformedResult.stdout)).toMatchObject({
      success: false,
      diagnostics: [{ code: 'PROJECT_BUNDLE_INVALID' }],
    });
    await expect(fs.stat(malformedDestination)).rejects.toMatchObject({ code: 'ENOENT' });

    const digestMismatchPath = path.join(root, 'digest-mismatch.ntproject');
    await fs.writeFile(
      digestMismatchPath,
      patchStoredEntryData(bundleBytes, 'workflows/image/manifest.json', (text) =>
        text.replace('portable-workflow', 'portable-workflov'),
      ),
    );
    const digestMismatchDestination = path.join(root, 'digest-mismatch-project');
    const digestMismatchResult = await runNovelTeaCli(
      ['--json', 'project', 'import', digestMismatchPath, digestMismatchDestination],
      { cwd: root },
    );
    expect(digestMismatchResult.exitCode).toBe(4);
    expect(JSON.parse(digestMismatchResult.stdout)).toMatchObject({
      success: false,
      diagnostics: [{ code: 'PROJECT_BUNDLE_INVALID' }],
    });
    await expect(fs.stat(digestMismatchDestination)).rejects.toMatchObject({ code: 'ENOENT' });

    const projectText = storedEntryText(bundleBytes, 'project.json');
    const invalidProjectText = projectText.replace(
      'noveltea.project.workspace',
      'noveltea.project.workspacx',
    );
    expect(invalidProjectText).not.toBe(projectText);
    const manifest = JSON.parse(storedEntryText(bundleBytes, 'ntproject.json')) as {
      files: Array<{ path: string; sha256: string }>;
    };
    const projectEntry = manifest.files.find((entry) => entry.path === 'project.json');
    expect(projectEntry).toBeDefined();
    const invalidProjectHash = `sha256:${createHash('sha256')
      .update(invalidProjectText, 'utf8')
      .digest('hex')}`;
    const withInvalidProject = patchStoredEntryData(
      bundleBytes,
      'project.json',
      () => invalidProjectText,
    );
    const invalidProjectBundle = patchStoredEntryData(
      withInvalidProject,
      'ntproject.json',
      (text) => text.replace(projectEntry!.sha256, invalidProjectHash),
    );
    const invalidProjectPath = path.join(root, 'invalid-project.ntproject');
    await fs.writeFile(invalidProjectPath, invalidProjectBundle);
    const invalidProjectDestination = path.join(root, 'invalid-workspace');
    const invalidProjectResult = await runNovelTeaCli(
      ['--json', 'project', 'import', invalidProjectPath, invalidProjectDestination],
      { cwd: root },
    );
    expect(invalidProjectResult.exitCode).toBe(4);
    expect(JSON.parse(invalidProjectResult.stdout)).toMatchObject({
      success: false,
      diagnostics: [{ code: 'PROJECT_BUNDLE_PROJECT_INVALID' }],
    });
    await expect(fs.stat(invalidProjectDestination)).rejects.toMatchObject({ code: 'ENOENT' });

    const unsafePath = path.join(root, 'unsafe.ntproject');
    await fs.writeFile(unsafePath, patchEntryPath(bundleBytes, 'editor.json', '../evil.txt'));
    const unsafeDestination = path.join(root, 'unsafe-project');
    const unsafeResult = await runNovelTeaCli(
      ['--json', 'project', 'import', unsafePath, unsafeDestination],
      { cwd: root },
    );
    expect(unsafeResult.exitCode).toBe(4);
    expect(JSON.parse(unsafeResult.stdout)).toMatchObject({
      success: false,
      diagnostics: [{ code: 'PROJECT_BUNDLE_INVALID' }],
    });
    await expect(fs.stat(unsafeDestination)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(root, 'evil.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    const excludedPath = path.join(root, 'excluded.ntproject');
    const excludedEntryPath = 'dist/xxxxxxxxxxxxxxxxxxx.json';
    const withExcludedManifest = patchStoredEntryData(bundleBytes, 'ntproject.json', (text) =>
      text.replace('workflows/image/manifest.json', excludedEntryPath),
    );
    await fs.writeFile(
      excludedPath,
      patchEntryPath(withExcludedManifest, 'workflows/image/manifest.json', excludedEntryPath),
    );
    const excludedDestination = path.join(root, 'excluded-project');
    const excludedResult = await runNovelTeaCli(
      ['--json', 'project', 'import', excludedPath, excludedDestination],
      { cwd: root },
    );
    expect(excludedResult.exitCode).toBe(4);
    expect(JSON.parse(excludedResult.stdout)).toMatchObject({
      success: false,
      diagnostics: [{ code: 'PROJECT_BUNDLE_INVALID' }],
    });
    await expect(fs.stat(excludedDestination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
