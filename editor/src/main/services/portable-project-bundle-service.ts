import { z } from 'zod';
import {
  PROJECT_WORKSPACE_SCHEMA,
  PROJECT_WORKSPACE_SCHEMA_VERSION,
  assertProjectWorkspacePathContained,
  type LoadedProjectWorkspaceSnapshot,
  type ProjectWorkspaceFileSystem,
  type ProjectWorkspaceService,
} from '../../shared/project-workspace';
import {
  assetSourcePaths,
  compareProjectWorkspaceUnicodeCodePoints,
} from '../../shared/project-workspace/project-workspace-service';
import { parseMaterialData } from '../../shared/project-schema/authoring-materials';
import { sha256PrefixedBytes } from '../../shared/web-crypto';
import { createPlatformArchive } from './platform-host-service';

export const PORTABLE_PROJECT_BUNDLE_SCHEMA = 'noveltea.project.bundle' as const;
export const PORTABLE_PROJECT_BUNDLE_VERSION = 1 as const;
export const PORTABLE_PROJECT_BUNDLE_MANIFEST = 'ntproject.json' as const;

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const portableProjectBundleManifestSchema = z
  .object({
    schema: z.literal(PORTABLE_PROJECT_BUNDLE_SCHEMA),
    version: z.literal(PORTABLE_PROJECT_BUNDLE_VERSION),
    workspace: z
      .object({
        schema: z.literal(PROJECT_WORKSPACE_SCHEMA),
        version: z.literal(PROJECT_WORKSPACE_SCHEMA_VERSION),
      })
      .strict(),
    project: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
      })
      .strict(),
    files: z.array(
      z
        .object({
          path: z.string().min(1),
          size: z.number().int().nonnegative(),
          sha256: sha256Schema,
        })
        .strict(),
    ),
  })
  .strict();

export type PortableProjectBundleManifest = z.infer<typeof portableProjectBundleManifestSchema>;

export type PortableProjectBundleFailureKind =
  | 'conflict'
  | 'invalid-bundle'
  | 'invalid-project'
  | 'mutation'
  | 'source-changed';

export class PortableProjectBundleError extends Error {
  constructor(
    readonly kind: PortableProjectBundleFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'PortableProjectBundleError';
  }
}

interface PortableProjectSourceEntry {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly sha256: `sha256:${string}`;
}

interface ParsedZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

let bundleSequence = 0;

function isSafeBundlePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/u.test(value) &&
    value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

function isExcludedPortableProjectPath(value: string): boolean {
  const segments = value.split('/').map((segment) => segment.toLocaleLowerCase('en-US'));
  const root = segments[0];
  return (
    segments.some(
      (segment) =>
        segment === '.noveltea' || segment === '.git' || segment === '.hg' || segment === '.svn',
    ) ||
    root === 'dist' ||
    root === '.gitignore' ||
    root === '.gitattributes' ||
    root === '.gitmodules'
  );
}

function assertNtprojectExtension(value: string): void {
  if (!value.toLocaleLowerCase('en-US').endsWith('.ntproject'))
    throw new PortableProjectBundleError(
      'mutation',
      "Portable Project bundle paths must use the '.ntproject' extension.",
    );
}

async function uniqueSiblingDirectory(
  fileSystem: ProjectWorkspaceFileSystem,
  destination: string,
  label: string,
): Promise<string> {
  const parent = fileSystem.dirname(destination);
  const base = destination.slice(parent.length).replace(/^[/\\]+/u, '') || 'project';
  for (;;) {
    bundleSequence += 1;
    const candidate = fileSystem.joinPath(
      parent,
      `.${base}.noveltea-${label}-${process.pid}-${bundleSequence}`,
    );
    if (await fileSystem.createDirectoryExclusive(candidate)) return candidate;
  }
}

async function collectWorkflowFiles(
  fileSystem: ProjectWorkspaceFileSystem,
  projectRoot: string,
): Promise<string[]> {
  const root = fileSystem.joinPath(projectRoot, 'workflows');
  if ((await fileSystem.inspect(root)) !== 'directory') return [];
  await assertProjectWorkspacePathContained(fileSystem, projectRoot, root);
  const output: string[] = [];
  const visitedDirectories = new Set<string>();
  const visit = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
    const realDirectory = await fileSystem.realpath(absoluteDirectory);
    if (visitedDirectories.has(realDirectory))
      throw new PortableProjectBundleError(
        'mutation',
        `Project workflow directory '${relativeDirectory || 'workflows'}' resolves to a directory already visited.`,
      );
    visitedDirectories.add(realDirectory);
    const names = [...(await fileSystem.listDirectory(absoluteDirectory))].sort(
      compareProjectWorkspaceUnicodeCodePoints,
    );
    for (const name of names) {
      const absolute = fileSystem.joinPath(absoluteDirectory, name);
      await assertProjectWorkspacePathContained(fileSystem, projectRoot, absolute);
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (isExcludedPortableProjectPath(`workflows/${relative}`)) continue;
      const kind = await fileSystem.inspect(absolute);
      if (kind === 'directory') await visit(absolute, relative);
      else if (kind === 'file') output.push(`workflows/${relative}`);
      else
        throw new PortableProjectBundleError(
          'mutation',
          `Project workflow path '${relative}' is not a regular file or directory.`,
        );
    }
  };
  await visit(root, '');
  return output;
}

async function portableProjectOwnedPaths(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
): Promise<string[]> {
  const paths = new Set<string>(snapshot.canonicalSourceFiles);
  const addOwnedSourcePath = (sourcePath: string, label: string): void => {
    if (sourcePath === PORTABLE_PROJECT_BUNDLE_MANIFEST)
      throw new PortableProjectBundleError(
        'invalid-project',
        `${label} source path '${sourcePath}' collides with the reserved portable Project bundle manifest path.`,
      );
    if (isExcludedPortableProjectPath(sourcePath))
      throw new PortableProjectBundleError(
        'invalid-project',
        `${label} source path '${sourcePath}' belongs to local, generated, or VCS state excluded from portable Project bundles.`,
      );
    paths.add(sourcePath);
  };
  for (const sourcePath of assetSourcePaths(snapshot.project))
    addOwnedSourcePath(sourcePath, 'Asset');
  for (const record of Object.values(snapshot.project.materials)) {
    const material = parseMaterialData(record.data);
    if (!material)
      throw new PortableProjectBundleError(
        'invalid-project',
        `Material '${record.id}' is invalid and cannot be exported.`,
      );
    for (const stage of ['vertex', 'fragment', 'varying'] as const) {
      const source = material.shader?.[stage];
      if (source?.kind === 'project') addOwnedSourcePath(source.path, 'Shader');
    }
  }
  for (const workflowPath of await collectWorkflowFiles(fileSystem, snapshot.projectRoot))
    paths.add(workflowPath);
  return [...paths].sort(compareProjectWorkspaceUnicodeCodePoints);
}

async function collectPortableProjectEntries(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
): Promise<PortableProjectSourceEntry[]> {
  const result: PortableProjectSourceEntry[] = [];
  for (const relativePath of await portableProjectOwnedPaths(fileSystem, snapshot)) {
    if (!isSafeBundlePath(relativePath))
      throw new PortableProjectBundleError(
        'mutation',
        `Project source path '${relativePath}' is not portable.`,
      );
    const absolutePath = fileSystem.joinPath(snapshot.projectRoot, relativePath);
    await assertProjectWorkspacePathContained(fileSystem, snapshot.projectRoot, absolutePath);
    if ((await fileSystem.inspect(absolutePath)) !== 'file')
      throw new PortableProjectBundleError(
        'mutation',
        `Project source file '${relativePath}' is missing.`,
      );
    const current = await fileSystem.readFileRevision(absolutePath);
    const captured = snapshot.fileRevisions[relativePath];
    if (captured && captured.contentHash !== current.contentHash)
      throw new PortableProjectBundleError(
        'source-changed',
        `Project source file '${relativePath}' changed while preparing the bundle.`,
      );
    result.push({
      relativePath,
      absolutePath,
      size: current.byteSize,
      sha256: current.contentHash,
    });
  }
  return result;
}

function canonicalManifestText(manifest: PortableProjectBundleManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function assertPortableProjectSourcesUnchanged(
  fileSystem: ProjectWorkspaceFileSystem,
  sources: readonly PortableProjectSourceEntry[],
): Promise<void> {
  for (const source of sources) {
    const current = await fileSystem.readFileRevision(source.absolutePath);
    if (current.contentHash !== source.sha256 || current.byteSize !== source.size)
      throw new PortableProjectBundleError(
        'source-changed',
        `Project source file '${source.relativePath}' changed while preparing the bundle.`,
      );
  }
}

export async function exportPortableProjectBundle(
  fileSystem: ProjectWorkspaceFileSystem,
  snapshot: LoadedProjectWorkspaceSnapshot,
  outputPathInput: string,
): Promise<{ readonly outputPath: string; readonly manifest: PortableProjectBundleManifest }> {
  const outputPath = fileSystem.resolvePath(outputPathInput);
  assertNtprojectExtension(outputPath);
  if ((await fileSystem.inspect(outputPath)) !== 'missing')
    throw new PortableProjectBundleError(
      'conflict',
      'Portable Project bundle destination already exists.',
    );
  await fileSystem.createDirectory(fileSystem.dirname(outputPath));

  const sources = await collectPortableProjectEntries(fileSystem, snapshot);
  const manifest: PortableProjectBundleManifest = {
    schema: PORTABLE_PROJECT_BUNDLE_SCHEMA,
    version: PORTABLE_PROJECT_BUNDLE_VERSION,
    workspace: {
      schema: PROJECT_WORKSPACE_SCHEMA,
      version: PROJECT_WORKSPACE_SCHEMA_VERSION,
    },
    project: { id: snapshot.project.project.id, name: snapshot.project.project.name },
    files: sources.map((entry) => ({
      path: entry.relativePath,
      size: entry.size,
      sha256: entry.sha256,
    })),
  };

  const staging = await uniqueSiblingDirectory(fileSystem, outputPath, 'bundle');
  const manifestSource = fileSystem.joinPath(staging, PORTABLE_PROJECT_BUNDLE_MANIFEST);
  const stagedBundle = fileSystem.joinPath(staging, 'bundle.ntproject');
  try {
    await fileSystem.writeTextAtomic(manifestSource, canonicalManifestText(manifest));
    const manifestRevision = await fileSystem.readFileRevision(manifestSource);
    await createPlatformArchive({
      outputPath: stagedBundle,
      format: 'zip',
      compression: 'store',
      entries: [
        {
          sourcePath: manifestSource,
          archivePath: PORTABLE_PROJECT_BUNDLE_MANIFEST,
          size: manifestRevision.byteSize,
          mode: 0o644,
        },
        ...sources.map((entry) => ({
          sourcePath: entry.absolutePath,
          archivePath: entry.relativePath,
          size: entry.size,
          mode: 0o644,
        })),
      ],
    });
    await assertPortableProjectSourcesUnchanged(fileSystem, sources);
    if ((await fileSystem.inspect(outputPath)) !== 'missing')
      throw new PortableProjectBundleError(
        'conflict',
        'Portable Project bundle destination was created while the bundle was being prepared.',
      );
    await fileSystem.movePathAtomic(stagedBundle, outputPath);
    return { outputPath, manifest };
  } catch (error) {
    if (error instanceof PortableProjectBundleError) throw error;
    throw new PortableProjectBundleError(
      'mutation',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if ((await fileSystem.inspect(staging)) !== 'missing')
      await fileSystem.removeDirectory(staging);
  }
}

function u16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength)
    throw new PortableProjectBundleError(
      'invalid-bundle',
      'Portable Project archive is truncated.',
    );
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength)
    throw new PortableProjectBundleError(
      'invalid-bundle',
      'Portable Project archive is truncated.',
    );
  return view.getUint32(offset, true);
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1)
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function parsePortableZip(bytes: Uint8Array): ParsedZipEntry[] {
  if (bytes.byteLength < 22)
    throw new PortableProjectBundleError(
      'invalid-bundle',
      'Portable Project archive is truncated.',
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const floor = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= floor; offset -= 1) {
    if (u32(view, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0)
    throw new PortableProjectBundleError(
      'invalid-bundle',
      'Portable Project archive has no ZIP directory.',
    );
  const disk = u16(view, eocd + 4);
  const centralDisk = u16(view, eocd + 6);
  const diskEntries = u16(view, eocd + 8);
  const totalEntries = u16(view, eocd + 10);
  const centralSize = u32(view, eocd + 12);
  const centralOffset = u32(view, eocd + 16);
  const commentLength = u16(view, eocd + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    commentLength !== 0 ||
    eocd + 22 !== bytes.byteLength ||
    centralOffset + centralSize !== eocd
  )
    throw new PortableProjectBundleError(
      'invalid-bundle',
      'Portable Project archive uses an unsupported ZIP layout.',
    );

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries: ParsedZipEntry[] = [];
  const paths = new Set<string>();
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (u32(view, cursor) !== 0x02014b50)
      throw new PortableProjectBundleError(
        'invalid-bundle',
        'Portable Project ZIP directory is malformed.',
      );
    const flags = u16(view, cursor + 8);
    const method = u16(view, cursor + 10);
    const compressedSize = u32(view, cursor + 20);
    const size = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const entryCommentLength = u16(view, cursor + 32);
    const diskStart = u16(view, cursor + 34);
    const externalAttributes = u32(view, cursor + 38);
    const localOffset = u32(view, cursor + 42);
    if (
      flags !== 0x0808 ||
      method !== 0 ||
      compressedSize !== size ||
      extraLength !== 0 ||
      entryCommentLength !== 0 ||
      diskStart !== 0
    )
      throw new PortableProjectBundleError(
        'invalid-bundle',
        'Portable Project archive uses unsupported ZIP entry features.',
      );
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) !== 0o100000)
      throw new PortableProjectBundleError(
        'invalid-bundle',
        'Portable Project archive entries must be regular files.',
      );
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > eocd)
      throw new PortableProjectBundleError(
        'invalid-bundle',
        'Portable Project ZIP directory is truncated.',
      );
    let entryPath: string;
    try {
      entryPath = decoder.decode(bytes.subarray(nameStart, nameEnd));
    } catch {
      throw new PortableProjectBundleError(
        'invalid-bundle',
        'Portable Project archive contains an invalid UTF-8 path.',
      );
    }
    if (!isSafeBundlePath(entryPath) || paths.has(entryPath))
      throw new PortableProjectBundleError(
        'invalid-bundle',
        `Portable Project archive contains unsafe or duplicate path '${entryPath}'.`,
      );
    paths.add(entryPath);

    if (u32(view, localOffset) !== 0x04034b50)
      throw new PortableProjectBundleError(
        'invalid-bundle',
        'Portable Project ZIP local entry is malformed.',
      );
    const localFlags = u16(view, localOffset + 6);
    const localMethod = u16(view, localOffset + 8);
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    if (
      localFlags !== flags ||
      localMethod !== method ||
      localNameLength !== nameLength ||
      localExtraLength !== 0
    )
      throw new PortableProjectBundleError(
        'invalid-bundle',
        'Portable Project ZIP entry headers disagree.',
      );
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    let localName: string;
    try {
      localName = decoder.decode(bytes.subarray(localNameStart, localNameEnd));
    } catch {
      throw new PortableProjectBundleError(
        'invalid-bundle',
        'Portable Project ZIP local path is invalid UTF-8.',
      );
    }
    if (localName !== entryPath)
      throw new PortableProjectBundleError(
        'invalid-bundle',
        'Portable Project ZIP entry path mismatch.',
      );
    const dataStart = localNameEnd;
    const dataEnd = dataStart + size;
    const descriptorEnd = dataEnd + 16;
    if (descriptorEnd > centralOffset || u32(view, dataEnd) !== 0x08074b50)
      throw new PortableProjectBundleError(
        'invalid-bundle',
        'Portable Project ZIP data descriptor is malformed.',
      );
    const data = bytes.slice(dataStart, dataEnd);
    const expectedCrc = u32(view, cursor + 16);
    if (
      u32(view, dataEnd + 4) !== expectedCrc ||
      u32(view, dataEnd + 8) !== size ||
      u32(view, dataEnd + 12) !== size ||
      crc32(data) !== expectedCrc
    )
      throw new PortableProjectBundleError(
        'invalid-bundle',
        `Portable Project ZIP entry '${entryPath}' is corrupt.`,
      );
    entries.push({ path: entryPath, bytes: data });
    cursor = nameEnd;
  }
  if (cursor !== eocd)
    throw new PortableProjectBundleError(
      'invalid-bundle',
      'Portable Project ZIP directory size is inconsistent.',
    );
  return entries;
}

function parseBundleManifest(entries: readonly ParsedZipEntry[]): PortableProjectBundleManifest {
  const manifestEntry = entries.find((entry) => entry.path === PORTABLE_PROJECT_BUNDLE_MANIFEST);
  if (!manifestEntry)
    throw new PortableProjectBundleError(
      'invalid-bundle',
      `Portable Project archive is missing '${PORTABLE_PROJECT_BUNDLE_MANIFEST}'.`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(manifestEntry.bytes),
    ) as unknown;
  } catch {
    throw new PortableProjectBundleError(
      'invalid-bundle',
      'Portable Project bundle manifest is malformed.',
    );
  }
  const manifest = portableProjectBundleManifestSchema.safeParse(parsed);
  if (!manifest.success)
    throw new PortableProjectBundleError(
      'invalid-bundle',
      'Portable Project bundle manifest identity, version, or shape is unsupported.',
    );
  const sorted = [...manifest.data.files].sort((left, right) =>
    compareProjectWorkspaceUnicodeCodePoints(left.path, right.path),
  );
  if (
    sorted.some((entry, index) => entry.path !== manifest.data.files[index]?.path) ||
    sorted.some((entry, index) => index > 0 && entry.path === sorted[index - 1]?.path) ||
    sorted.some(
      (entry) => !isSafeBundlePath(entry.path) || entry.path === PORTABLE_PROJECT_BUNDLE_MANIFEST,
    )
  )
    throw new PortableProjectBundleError(
      'invalid-bundle',
      'Portable Project bundle manifest file inventory is not canonical.',
    );
  return manifest.data;
}

async function validateBundleInventory(
  entries: readonly ParsedZipEntry[],
  manifest: PortableProjectBundleManifest,
): Promise<void> {
  if (entries.length !== manifest.files.length + 1)
    throw new PortableProjectBundleError(
      'invalid-bundle',
      'Portable Project archive contains files not declared by its manifest.',
    );
  const byPath = new Map(entries.map((entry) => [entry.path, entry] as const));
  for (const declared of manifest.files) {
    const actual = byPath.get(declared.path);
    if (!actual || actual.bytes.byteLength !== declared.size)
      throw new PortableProjectBundleError(
        'invalid-bundle',
        `Portable Project archive does not match manifest entry '${declared.path}'.`,
      );
    if ((await sha256PrefixedBytes(actual.bytes)) !== declared.sha256)
      throw new PortableProjectBundleError(
        'invalid-bundle',
        `Portable Project archive checksum mismatch for '${declared.path}'.`,
      );
  }
}

async function rejectExistingDestination(
  fileSystem: ProjectWorkspaceFileSystem,
  destination: string,
): Promise<void> {
  if ((await fileSystem.inspect(destination)) === 'missing') return;
  throw new PortableProjectBundleError(
    'conflict',
    'Portable Project import destination already exists. Choose a new folder.',
  );
}

export async function importPortableProjectBundle(
  fileSystem: ProjectWorkspaceFileSystem,
  workspace: ProjectWorkspaceService,
  bundlePathInput: string,
  destinationInput: string,
  options: { readonly projectName?: string } = {},
): Promise<{
  readonly projectRoot: string;
  readonly projectFilePath: string;
  readonly manifest: PortableProjectBundleManifest;
}> {
  const bundlePath = fileSystem.resolvePath(bundlePathInput);
  const destination = fileSystem.resolvePath(destinationInput);
  assertNtprojectExtension(bundlePath);
  if ((await fileSystem.inspect(bundlePath)) !== 'file')
    throw new PortableProjectBundleError(
      'invalid-bundle',
      'Portable Project bundle does not exist.',
    );
  await rejectExistingDestination(fileSystem, destination);

  let entries: ParsedZipEntry[];
  try {
    entries = parsePortableZip(await fileSystem.readBytes(bundlePath));
  } catch (error) {
    if (error instanceof PortableProjectBundleError) throw error;
    throw new PortableProjectBundleError(
      'invalid-bundle',
      error instanceof Error ? error.message : String(error),
    );
  }
  const manifest = parseBundleManifest(entries);
  await validateBundleInventory(entries, manifest);

  await fileSystem.createDirectory(fileSystem.dirname(destination));
  const staging = await uniqueSiblingDirectory(fileSystem, destination, 'import');
  try {
    for (const entry of entries) {
      if (entry.path === PORTABLE_PROJECT_BUNDLE_MANIFEST) continue;
      const target = fileSystem.joinPath(staging, entry.path);
      await assertProjectWorkspacePathContained(fileSystem, staging, target);
      await fileSystem.writeBytesAtomic(target, entry.bytes);
    }
    for (const directory of ['records', 'scripts', 'assets'])
      await fileSystem.createDirectory(fileSystem.joinPath(staging, directory));

    const opened = await workspace.open(staging);
    if (!opened.ok || opened.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      const diagnostic =
        opened.diagnostics.find((candidate) => candidate.severity === 'error') ??
        opened.diagnostics[0];
      throw new PortableProjectBundleError(
        'invalid-project',
        diagnostic?.message ?? 'Portable Project contains an invalid Project Workspace.',
      );
    }
    if (
      opened.snapshot.project.project.id !== manifest.project.id ||
      opened.snapshot.project.project.name !== manifest.project.name
    )
      throw new PortableProjectBundleError(
        'invalid-project',
        'Portable Project bundle metadata does not match the contained Project Workspace.',
      );
    const expectedPaths = await portableProjectOwnedPaths(fileSystem, opened.snapshot);
    const declaredPaths = manifest.files.map((entry) => entry.path);
    if (
      expectedPaths.length !== declaredPaths.length ||
      expectedPaths.some((entry, index) => entry !== declaredPaths[index])
    )
      throw new PortableProjectBundleError(
        'invalid-bundle',
        'Portable Project bundle contains files outside the current Project authoring contract or omits required project-owned files.',
      );

    const projectName = options.projectName?.trim();
    if (options.projectName !== undefined && !projectName)
      throw new PortableProjectBundleError('invalid-project', 'Imported Project name is required.');
    if (projectName && projectName !== opened.snapshot.project.project.name) {
      await workspace.write(
        staging,
        opened.snapshot.workspaceRevision,
        {
          ...opened.snapshot.project,
          project: { ...opened.snapshot.project.project, name: projectName },
        },
        opened.snapshot.project.editor,
        opened.snapshot.scriptSourcePaths,
        {
          preflightSnapshot: opened.snapshot,
          operationLabel: 'portable project import rename',
        },
      );
    }

    await rejectExistingDestination(fileSystem, destination);
    await fileSystem.movePathAtomic(staging, destination);
    return {
      projectRoot: destination,
      projectFilePath: fileSystem.joinPath(destination, 'project.json'),
      manifest,
    };
  } catch (error) {
    if (error instanceof PortableProjectBundleError) throw error;
    throw new PortableProjectBundleError(
      'mutation',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if ((await fileSystem.inspect(staging)) !== 'missing')
      await fileSystem.removeDirectory(staging);
  }
}
