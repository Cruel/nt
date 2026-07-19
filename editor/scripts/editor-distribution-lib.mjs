import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repositoryRoot = path.resolve(editorRoot, '..');
export const distributionRoot = path.join(editorRoot, 'out', 'electron-builder');
export const previewSourceRoot = path.join(
  repositoryRoot,
  'build',
  'web-release',
  'apps',
  'sandbox',
);
export const editorAssetsSourceRoot = path.join(editorRoot, 'assets');

export const requiredPreviewFiles = ['index.html', 'index.js', 'index.wasm', 'index.data'];
export const allowedPreviewExtensions = new Set([
  '.css',
  '.data',
  '.gif',
  '.html',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.mjs',
  '.png',
  '.svg',
  '.ttf',
  '.wasm',
  '.woff',
  '.woff2',
]);

const forbiddenProductionPackages = new Set([
  '@electron-forge/cli',
  '@electron-forge/shared-types',
  '@testing-library/react',
  '@testing-library/user-event',
  '@vitejs/plugin-react',
  'electron',
  'electron-builder',
  'jsdom',
  'react',
  'react-dom',
  'tailwindcss',
  'typescript',
  'vite',
  'vite-plus',
  'vitest',
]);

const textExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.rml',
  '.rcss',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

function formatCommand(command, args) {
  return [command, ...args]
    .map((part) => (part.includes(' ') ? JSON.stringify(part) : part))
    .join(' ');
}

export function runCommand(command, args, options = {}) {
  const { cwd = repositoryRoot, env = process.env, label, capture = false } = options;
  if (label) console.log(`[${label}] ${formatCommand(command, args)}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = capture && stderr.trim() ? `\n${stderr.trim()}` : '';
      reject(
        new Error(
          `${formatCommand(command, args)} failed (exit=${code ?? 'null'}, signal=${signal ?? 'none'}).${detail}`,
        ),
      );
    });
  });
}

export async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function readJson(target) {
  return JSON.parse(await readFile(target, 'utf8'));
}

export async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function sha256File(target) {
  const contents = await readFile(target);
  return createHash('sha256').update(contents).digest('hex');
}

export async function listTree(root, relativeRoot = '') {
  const absoluteRoot = path.join(root, relativeRoot);
  if (!(await pathExists(absoluteRoot))) return [];
  const records = [];

  async function visit(absolutePath, relativePath) {
    const info = await lstat(absolutePath);
    const normalizedPath = relativePath.split(path.sep).join('/');
    if (info.isSymbolicLink()) {
      const linkTarget = await readlink(absolutePath);
      records.push({
        path: normalizedPath,
        type: 'symlink',
        size: Buffer.byteLength(linkTarget),
        mode: info.mode & 0o777,
        sha256: createHash('sha256').update(linkTarget).digest('hex'),
        linkTarget,
      });
      return;
    }
    if (info.isDirectory()) {
      const entries = await readdir(absolutePath, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        await visit(path.join(absolutePath, entry.name), path.join(relativePath, entry.name));
      }
      return;
    }
    if (!info.isFile()) return;
    records.push({
      path: normalizedPath,
      type: 'file',
      size: info.size,
      mode: info.mode & 0o777,
      sha256: await sha256File(absolutePath),
    });
  }

  await visit(absoluteRoot, relativeRoot);
  return records.filter((record) => record.path.length > 0);
}

function hashRecords(records) {
  const hash = createHash('sha256');
  for (const record of records) {
    hash.update(
      `${record.path}\0${record.type}\0${record.size}\0${record.mode}\0${record.sha256}\0${record.linkTarget ?? ''}\n`,
    );
  }
  return hash.digest('hex');
}

async function getGitRevision() {
  try {
    const { stdout } = await runCommand('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      capture: true,
    });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

function normalizeReleaseTag(input) {
  if (!input) return null;
  const tag = input.trim();
  if (!tag) return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)([-+][0-9A-Za-z.-]+)?$/.exec(tag);
  if (!match) {
    throw new Error(
      `Invalid release tag ${JSON.stringify(tag)}. Expected vMAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH.`,
    );
  }
  return {
    releaseTag: tag,
    version: `${match[1]}.${match[2]}.${match[3]}${match[4] ?? ''}`,
  };
}

export async function resolveBuildIdentity(explicitReleaseTag) {
  const revision = await getGitRevision();
  const release = normalizeReleaseTag(explicitReleaseTag ?? process.env.NOVELTEA_RELEASE_TAG);
  if (release) return { ...release, revision };
  if (process.env.CI === 'true') {
    throw new Error('CI distribution builds require --release-tag or NOVELTEA_RELEASE_TAG.');
  }
  const suffix = /^[0-9a-f]{7,}$/i.test(revision) ? revision.slice(0, 12) : 'unknown';
  return { releaseTag: null, version: `0.0.0-dev.${suffix}`, revision };
}

async function getElectronMetadata() {
  const editorRequire = createRequire(path.join(editorRoot, 'package.json'));
  const electronPackage = editorRequire('electron/package.json');
  const electronExecutable = editorRequire('electron');
  const { stdout } = await runCommand(
    electronExecutable,
    ['-p', 'JSON.stringify(process.versions)'],
    {
      cwd: editorRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      capture: true,
    },
  );
  const versions = JSON.parse(stdout.trim());
  return {
    electronVersion: electronPackage.version,
    nodeAbi: versions.modules,
    embeddedNodeVersion: versions.node,
  };
}

function expectedEditorToolName(platform = process.platform) {
  return platform === 'win32' ? 'noveltea-editor-tool.exe' : 'noveltea-editor-tool';
}

export function resolveEditorToolSource() {
  const configured = process.env.NOVELTEA_EDITOR_TOOL_PATH?.trim();
  if (configured) return path.resolve(configured);
  const toolName = expectedEditorToolName();
  const platformDirectory =
    process.platform === 'win32'
      ? 'windows-release'
      : process.platform === 'darwin'
        ? 'macos-release'
        : 'linux-release';
  const candidates = [
    path.join(repositoryRoot, 'build', platformDirectory, 'tools', 'editor_tool', toolName),
    path.join(
      repositoryRoot,
      'build',
      platformDirectory,
      'tools',
      'editor_tool',
      'Release',
      toolName,
    ),
  ];
  return candidates.find((candidate) => {
    try {
      return createRequire(import.meta.url)('node:fs')
        .statSync(candidate)
        .isFile();
    } catch {
      return false;
    }
  });
}

async function copyPreview(destination) {
  for (const required of requiredPreviewFiles) {
    const source = path.join(previewSourceRoot, required);
    if (!(await pathExists(source))) {
      throw new Error(`Required engine-preview file is missing: ${source}`);
    }
  }
  await mkdir(destination, { recursive: true });
  const entries = await readdir(previewSourceRoot, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) continue;
    if (!allowedPreviewExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    await cp(path.join(previewSourceRoot, entry.name), path.join(destination, entry.name));
  }
}

async function copyResources(resourcesRoot) {
  const editorToolSource = resolveEditorToolSource();
  if (!editorToolSource || !(await pathExists(editorToolSource))) {
    throw new Error(
      'The host NovelTea editor tool is missing. Build the host release editor_tool target or set NOVELTEA_EDITOR_TOOL_PATH.',
    );
  }
  await copyPreview(path.join(resourcesRoot, 'engine-preview'));
  if (!(await pathExists(path.join(editorAssetsSourceRoot, 'internal-preview')))) {
    throw new Error(`Editor assets directory is missing: ${editorAssetsSourceRoot}`);
  }
  await cp(editorAssetsSourceRoot, path.join(resourcesRoot, 'editor-assets'), {
    recursive: true,
    dereference: true,
  });
  const destinationTool = path.join(resourcesRoot, 'bin', expectedEditorToolName());
  await mkdir(path.dirname(destinationTool), { recursive: true });
  await cp(editorToolSource, destinationTool);
  if (process.platform !== 'win32') await chmod(destinationTool, 0o755);
}

async function collectInstalledPackages(appRoot) {
  const nodeModulesRoot = path.join(appRoot, 'node_modules');
  const visited = new Set();
  const packages = new Map();

  async function visit(directory) {
    let canonical;
    try {
      canonical = await realpath(directory);
    } catch {
      return;
    }
    if (visited.has(canonical)) return;
    visited.add(canonical);
    const packageJsonPath = path.join(directory, 'package.json');
    if (await pathExists(packageJsonPath)) {
      const metadata = await readJson(packageJsonPath);
      if (typeof metadata.name === 'string' && typeof metadata.version === 'string') {
        packages.set(`${metadata.name}@${metadata.version}`, {
          name: metadata.name,
          version: metadata.version,
        });
      }
    }
    let entries;
    try {
      entries = await readdir(path.join(directory, 'node_modules'), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.bin' || entry.name === '.pnpm') continue;
      const child = path.join(directory, 'node_modules', entry.name);
      if (entry.name.startsWith('@')) {
        for (const scoped of await readdir(child, { withFileTypes: true })) {
          if (scoped.isDirectory() || scoped.isSymbolicLink())
            await visit(path.join(child, scoped.name));
        }
      } else if (entry.isDirectory() || entry.isSymbolicLink()) {
        await visit(child);
      }
    }
  }

  const topEntries = await readdir(nodeModulesRoot, { withFileTypes: true });
  for (const entry of topEntries) {
    if (entry.name === '.bin' || entry.name === '.pnpm') continue;
    const child = path.join(nodeModulesRoot, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scoped of await readdir(child, { withFileTypes: true })) {
        if (scoped.isDirectory() || scoped.isSymbolicLink())
          await visit(path.join(child, scoped.name));
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      await visit(child);
    }
  }
  return [...packages.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
}

async function pruneTypeOnlyOptionalPeerClosure(appRoot) {
  const virtualStoreRoot = path.join(appRoot, 'node_modules', '.pnpm');
  if (!(await pathExists(virtualStoreRoot))) return;
  const virtualStoreEntries = await readdir(virtualStoreRoot);
  await Promise.all(
    virtualStoreEntries
      .filter((entry) => entry.startsWith('@types+node@') || entry.startsWith('undici-types@'))
      .map((entry) => rm(path.join(virtualStoreRoot, entry), { recursive: true, force: true })),
  );
  await Promise.all([
    rm(path.join(virtualStoreRoot, 'node_modules', '@types'), { recursive: true, force: true }),
    rm(path.join(virtualStoreRoot, 'node_modules', 'undici-types'), {
      recursive: true,
      force: true,
    }),
  ]);
  for (const entry of virtualStoreEntries.filter((name) => name.startsWith('sharp@'))) {
    await rm(path.join(virtualStoreRoot, entry, 'node_modules', '@types'), {
      recursive: true,
      force: true,
    });
  }
  const modulesMetadataPath = path.join(appRoot, 'node_modules', '.modules.yaml');
  if (await pathExists(modulesMetadataPath)) {
    const modulesMetadata = await readJson(modulesMetadataPath);
    if (modulesMetadata.hoistedDependencies) {
      delete modulesMetadata.hoistedDependencies['@types/node@26.1.1'];
      delete modulesMetadata.hoistedDependencies['undici-types@8.3.0'];
    }
    await writeJson(modulesMetadataPath, modulesMetadata);
  }
}

async function runSharpOperation(appRoot) {
  const appRequire = createRequire(path.join(appRoot, 'package.json'));
  const sharp = appRequire('sharp');
  const encoded = await sharp({
    create: {
      width: 3,
      height: 2,
      channels: 4,
      background: { r: 20, g: 40, b: 60, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  const metadata = await sharp(encoded).metadata();
  if (metadata.format !== 'png' || metadata.width !== 3 || metadata.height !== 2) {
    throw new Error('The staged sharp encode/decode verification returned unexpected metadata.');
  }
}

function assertSafePackageMetadata(metadata) {
  if (metadata.main !== 'dist-electron/main/main.cjs') {
    throw new Error(`Unexpected deployed main entry: ${metadata.main}`);
  }
  if (metadata.scripts || metadata.devDependencies || metadata.optionalDependencies) {
    throw new Error('Deployed package metadata contains development-only fields.');
  }
  const dependencies = metadata.dependencies ?? {};
  if (Object.keys(dependencies).length !== 1 || dependencies.sharp !== '0.35.3') {
    throw new Error(
      `Unexpected top-level production dependency set: ${JSON.stringify(dependencies)}`,
    );
  }
  const serialized = JSON.stringify(metadata);
  if (/\b(?:workspace|catalog):/i.test(serialized)) {
    throw new Error('Deployed package metadata contains a workspace or catalog protocol.');
  }
  if (serialized.includes(repositoryRoot)) {
    throw new Error('Deployed package metadata contains the source checkout path.');
  }
}

async function assertTextDoesNotLeakSource(stageRoot, records) {
  for (const record of records) {
    if (record.type !== 'file' || record.size > 10 * 1024 * 1024) continue;
    if (!textExtensions.has(path.extname(record.path).toLowerCase())) continue;
    const contents = await readFile(path.join(stageRoot, ...record.path.split('/')), 'utf8');
    if (contents.includes(repositoryRoot)) {
      throw new Error(`Staged file contains the source checkout path: ${record.path}`);
    }
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(contents)) {
      throw new Error(`Staged file contains a private key: ${record.path}`);
    }
  }
}

function assertAllowedApplicationFiles(records) {
  const forbiddenTopLevel =
    /^(?:app\/)?(?:src|test|tests|fixtures|coverage|\.vite|out|forge\.config)/i;
  for (const record of records) {
    const relative = record.path.replace(/^app\//, '');
    if (forbiddenTopLevel.test(record.path)) {
      throw new Error(`Forbidden application path in stage: ${record.path}`);
    }
    if (!relative.startsWith('node_modules/') && !relative.startsWith('dist-electron/')) {
      if (relative !== 'package.json') {
        throw new Error(`Undeclared application file in stage: ${record.path}`);
      }
    }
    if (/electron-squirrel-startup|@electron-forge|forge\.config/i.test(record.path)) {
      throw new Error(`Forge/Squirrel file entered the production stage: ${record.path}`);
    }
    if (/\/(?:@types(?:\+|\/)|undici-types(?:@|\/))/i.test(record.path)) {
      throw new Error(`Type-only optional-peer file entered the production stage: ${record.path}`);
    }
    if (/\.(?:node|so(?:\.\d+)*)$|\.(?:dll|dylib)$/i.test(record.path)) {
      if (!relative.startsWith('node_modules/@img/') && !relative.includes('/node_modules/@img/')) {
        throw new Error(`Unexpected native runtime file in application stage: ${record.path}`);
      }
    }
  }
}

export async function verifyStage(stageRoot, options = {}) {
  const { verifyManifest = true, runSharp = true } = options;
  const appRoot = path.join(stageRoot, 'app');
  const resourcesRoot = path.join(stageRoot, 'resources');
  const manifestPath = path.join(stageRoot, 'stage-manifest.json');
  const metadata = await readJson(path.join(appRoot, 'package.json'));
  assertSafePackageMetadata(metadata);

  for (const required of [
    'dist-electron/main/main.cjs',
    'dist-electron/preload/preload.cjs',
    'dist-electron/renderer/index.html',
    'dist-electron/tools/project-compile.mjs',
    'dist-electron/tools/generate-compiled-project-goldens.mjs',
  ]) {
    if (!(await pathExists(path.join(appRoot, required)))) {
      throw new Error(`Required staged application file is missing: ${required}`);
    }
  }
  for (const required of requiredPreviewFiles) {
    if (!(await pathExists(path.join(resourcesRoot, 'engine-preview', required)))) {
      throw new Error(`Required staged engine-preview file is missing: ${required}`);
    }
  }
  for (const required of [
    'internal-preview/layout-fragment-host.rml',
    'internal-preview/layout-fragment-host.rcss',
  ]) {
    if (!(await pathExists(path.join(resourcesRoot, 'editor-assets', required)))) {
      throw new Error(`Required staged editor asset is missing: ${required}`);
    }
  }
  const toolPath = path.join(resourcesRoot, 'bin', expectedEditorToolName());
  const toolInfo = await stat(toolPath);
  if (!toolInfo.isFile() || (process.platform !== 'win32' && (toolInfo.mode & 0o111) === 0)) {
    throw new Error(`Staged editor tool is missing or not executable: ${toolPath}`);
  }

  const records = [
    ...(await listTree(stageRoot, 'app')),
    ...(await listTree(stageRoot, 'resources')),
  ].sort((left, right) => left.path.localeCompare(right.path));
  assertAllowedApplicationFiles(records.filter((record) => record.path.startsWith('app/')));
  await assertTextDoesNotLeakSource(stageRoot, records);

  const installedPackages = await collectInstalledPackages(appRoot);
  if (!installedPackages.some((entry) => entry.name === 'sharp' && entry.version === '0.35.3')) {
    throw new Error('The staged production closure does not contain sharp 0.35.3.');
  }
  for (const entry of installedPackages) {
    if (
      forbiddenProductionPackages.has(entry.name) ||
      entry.name.startsWith('@electron-forge/') ||
      entry.name.startsWith('@types/')
    ) {
      throw new Error(`Development-only package entered the production closure: ${entry.name}`);
    }
  }

  if (verifyManifest) {
    const manifest = await readJson(manifestPath);
    const expected = manifest.files ?? [];
    if (JSON.stringify(expected) !== JSON.stringify(records)) {
      throw new Error('Stage manifest file records do not match the staged tree.');
    }
    if (
      manifest.resourceRoots.enginePreview.sha256 !==
      hashRecords(records.filter((record) => record.path.startsWith('resources/engine-preview/')))
    ) {
      throw new Error('Engine-preview resource-root hash mismatch.');
    }
    if (
      manifest.resourceRoots.editorAssets.sha256 !==
      hashRecords(records.filter((record) => record.path.startsWith('resources/editor-assets/')))
    ) {
      throw new Error('Editor-assets resource-root hash mismatch.');
    }
    if (
      manifest.resourceRoots.bin.sha256 !==
      hashRecords(records.filter((record) => record.path.startsWith('resources/bin/')))
    ) {
      throw new Error('Native-tool resource-root hash mismatch.');
    }
  }
  if (runSharp) await runSharpOperation(appRoot);
  return { metadata, installedPackages, records };
}

async function buildManifest(stageRoot, identity) {
  const electron = await getElectronMetadata();
  const { installedPackages, records } = await verifyStage(stageRoot, {
    verifyManifest: false,
    runSharp: true,
  });
  return {
    schemaVersion: 1,
    application: {
      name: 'noveltea-editor',
      productName: 'NovelTea Editor',
      version: identity.version,
      releaseTag: identity.releaseTag,
    },
    target: {
      platform: process.platform,
      architecture: process.arch,
    },
    runtime: electron,
    buildRevision: identity.revision,
    productionDependencies: installedPackages,
    files: records,
    resourceRoots: {
      enginePreview: {
        path: 'resources/engine-preview',
        sha256: hashRecords(
          records.filter((record) => record.path.startsWith('resources/engine-preview/')),
        ),
      },
      editorAssets: {
        path: 'resources/editor-assets',
        sha256: hashRecords(
          records.filter((record) => record.path.startsWith('resources/editor-assets/')),
        ),
      },
      bin: {
        path: 'resources/bin',
        sha256: hashRecords(records.filter((record) => record.path.startsWith('resources/bin/'))),
      },
    },
    relocationValidation: {
      performed: false,
      verifiedAt: null,
    },
  };
}

function stageId(identity) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const revision = identity.revision === 'unknown' ? 'unknown' : identity.revision.slice(0, 12);
  return `${identity.version}-${process.platform}-${process.arch}-${revision}-${timestamp}`;
}

export async function createStage(options = {}) {
  const { build = true, keepStage = false, releaseTag } = options;
  const identity = await resolveBuildIdentity(releaseTag);
  await mkdir(distributionRoot, { recursive: true });
  const transactionRoot = await mkdtemp(path.join(distributionRoot, '.stage-'));
  const transactionStage = path.join(transactionRoot, 'stage');
  const finalStage = path.join(distributionRoot, 'stages', stageId(identity));
  let publishedStage = false;
  try {
    if (build) {
      await runCommand('pnpm', ['run', 'build'], { cwd: editorRoot, label: 'build' });
    }
    await mkdir(transactionStage, { recursive: true });
    const appRoot = path.join(transactionStage, 'app');
    await runCommand('pnpm', ['--filter', 'noveltea-editor', '--prod', 'deploy', appRoot], {
      cwd: repositoryRoot,
      label: 'deploy',
    });
    const deployedEntries = await readdir(appRoot);
    await Promise.all(
      deployedEntries
        .filter((entry) => !['package.json', 'dist-electron', 'node_modules'].includes(entry))
        .map((entry) => rm(path.join(appRoot, entry), { recursive: true, force: true })),
    );
    await pruneTypeOnlyOptionalPeerClosure(appRoot);
    const editorPackage = await readJson(path.join(editorRoot, 'package.json'));
    const deployedMetadata = {
      name: editorPackage.name,
      productName: editorPackage.productName,
      version: identity.version,
      description: editorPackage.description,
      homepage: editorPackage.homepage,
      repository: editorPackage.repository,
      main: 'dist-electron/main/main.cjs',
      private: true,
      author: editorPackage.author,
      license: editorPackage.license,
      dependencies: { sharp: '0.35.3' },
    };
    await writeJson(path.join(appRoot, 'package.json'), deployedMetadata);
    await copyResources(path.join(transactionStage, 'resources'));
    const manifest = await buildManifest(transactionStage, identity);
    await writeJson(path.join(transactionStage, 'stage-manifest.json'), manifest);
    await verifyStage(transactionStage);

    await mkdir(path.dirname(finalStage), { recursive: true });
    await rename(transactionStage, finalStage);
    publishedStage = true;
    const relocationRoot = await mkdtemp(
      path.join(os.tmpdir(), 'noveltea-editor-relocated-stage-'),
    );
    try {
      const relocatedStage = path.join(relocationRoot, 'stage');
      await cp(finalStage, relocatedStage, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      await verifyStage(relocatedStage);
      const verifiedAt = new Date().toISOString();
      for (const root of [finalStage, relocatedStage]) {
        const relocatedManifest = await readJson(path.join(root, 'stage-manifest.json'));
        relocatedManifest.relocationValidation = { performed: true, verifiedAt };
        await writeJson(path.join(root, 'stage-manifest.json'), relocatedManifest);
        await verifyStage(root);
      }
    } finally {
      await rm(relocationRoot, { recursive: true, force: true });
    }
    await writeJson(path.join(distributionRoot, 'latest-stage.json'), {
      stageRoot: finalStage,
      version: identity.version,
      releaseTag: identity.releaseTag,
    });
    console.log(`[stage] ${finalStage}`);
    return { stageRoot: finalStage, identity };
  } catch (error) {
    if (keepStage) {
      console.error(`[stage] retained failed transaction at ${transactionRoot}`);
    } else {
      await rm(transactionRoot, { recursive: true, force: true });
      if (publishedStage) await rm(finalStage, { recursive: true, force: true });
    }
    throw error;
  } finally {
    if (!keepStage) await rm(transactionRoot, { recursive: true, force: true });
  }
}

export function packageLayout(appOutDir) {
  if (process.platform === 'darwin') {
    const appBundle = path.join(appOutDir, 'NovelTea Editor.app');
    return {
      appBundle,
      executable: path.join(appBundle, 'Contents', 'MacOS', 'noveltea-editor'),
      resources: path.join(appBundle, 'Contents', 'Resources'),
    };
  }
  return {
    appBundle: appOutDir,
    executable: path.join(
      appOutDir,
      process.platform === 'win32' ? 'noveltea-editor.exe' : 'noveltea-editor',
    ),
    resources: path.join(appOutDir, 'resources'),
  };
}

export async function findPackagedApplication(outputRoot) {
  const entries = await readdir(outputRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/(?:unpacked|NovelTea Editor\.app$)/.test(entry.name)) continue;
    const candidate = packageLayout(path.join(outputRoot, entry.name));
    if (await pathExists(candidate.executable)) return candidate;
  }
  if (process.platform === 'darwin') {
    const direct = packageLayout(outputRoot);
    if (await pathExists(direct.executable)) return direct;
  }
  throw new Error(`Unable to locate the packaged NovelTea Editor under ${outputRoot}.`);
}
