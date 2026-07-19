import { extractFile, listPackage } from '@electron/asar';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  findPackagedApplication,
  packageLayout,
  pathExists,
  requiredPreviewFiles,
} from './editor-distribution-lib.mjs';

const expectedFuses = new Map([
  [FuseV1Options.RunAsNode, FuseState.DISABLE],
  [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
  [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
]);

function normalizeAsarEntry(entry) {
  return entry
    .replace(/^[/\\]+/, '')
    .split('\\')
    .join('/');
}

async function findSharpNativeClosure(unpackedRoot) {
  const imageRoot = path.join(unpackedRoot, 'node_modules', '@img');
  const packages = await readdir(imageRoot, { withFileTypes: true });
  const sharpPackages = packages
    .filter((entry) => entry.isDirectory() && /^sharp-(?!libvips-)/.test(entry.name))
    .map((entry) => entry.name);
  const libvipsPackages = packages
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('sharp-libvips-'))
    .map((entry) => entry.name);
  if (sharpPackages.length === 0 || libvipsPackages.length === 0) {
    throw new Error(
      `Packaged @img closure is incomplete (sharp=${sharpPackages.join(',')}, libvips=${libvipsPackages.join(',')}).`,
    );
  }

  async function containsNativeFile(root, pattern) {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) {
        if (await containsNativeFile(target, pattern)) return true;
      } else if (entry.isFile() && pattern.test(entry.name)) {
        return true;
      }
    }
    return false;
  }

  const hasBinding = await Promise.all(
    sharpPackages.map((packageName) =>
      containsNativeFile(path.join(imageRoot, packageName), /\.node$/i),
    ),
  );
  const hasLibrary = await Promise.all(
    libvipsPackages.map((packageName) =>
      containsNativeFile(
        path.join(imageRoot, packageName),
        /\.(?:so(?:\.\d+)*)$|\.(?:dll|dylib)$/i,
      ),
    ),
  );
  if (!hasBinding.some(Boolean)) throw new Error('No unpacked sharp native binding was found.');
  if (!hasLibrary.some(Boolean)) throw new Error('No unpacked libvips shared library was found.');
  return { sharpPackages, libvipsPackages };
}

export async function verifyPackagedEditor(outputOrApplication) {
  let application;
  if (outputOrApplication && typeof outputOrApplication === 'object') {
    application = outputOrApplication;
  } else {
    const target = path.resolve(outputOrApplication);
    const direct = packageLayout(target);
    application = (await pathExists(direct.executable))
      ? direct
      : await findPackagedApplication(target);
  }

  const executableInfo = await stat(application.executable);
  if (!executableInfo.isFile()) throw new Error('Packaged executable is not a file.');
  const appAsar = path.join(application.resources, 'app.asar');
  const unpackedRoot = `${appAsar}.unpacked`;
  if (!(await pathExists(appAsar))) throw new Error(`ASAR archive is missing: ${appAsar}`);
  if (await pathExists(path.join(application.resources, 'app'))) {
    throw new Error('A loose resources/app directory exists despite OnlyLoadAppFromAsar policy.');
  }

  const entries = listPackage(appAsar, { isPack: false }).map(normalizeAsarEntry);
  for (const required of [
    'package.json',
    'dist-electron/main/main.cjs',
    'dist-electron/preload/preload.cjs',
    'dist-electron/renderer/index.html',
    'node_modules/sharp/package.json',
  ]) {
    if (!entries.includes(required)) throw new Error(`Required ASAR entry is missing: ${required}`);
  }
  for (const entry of entries) {
    if (/^(?:src|test|tests|fixtures|coverage|\.vite|out)\//i.test(entry)) {
      throw new Error(`Development path entered app.asar: ${entry}`);
    }
  }

  const packageMetadata = JSON.parse(extractFile(appAsar, 'package.json').toString('utf8'));
  if (
    packageMetadata.name !== 'noveltea-editor' ||
    packageMetadata.productName !== 'NovelTea Editor' ||
    packageMetadata.main !== 'dist-electron/main/main.cjs'
  ) {
    throw new Error(`Unexpected packaged application metadata: ${JSON.stringify(packageMetadata)}`);
  }
  if (JSON.stringify(packageMetadata).match(/\b(?:workspace|catalog):/i)) {
    throw new Error('Packaged metadata contains a workspace or catalog protocol.');
  }

  for (const required of requiredPreviewFiles) {
    if (!(await pathExists(path.join(application.resources, 'engine-preview', required)))) {
      throw new Error(`Packaged engine-preview resource is missing: ${required}`);
    }
  }
  for (const required of [
    'internal-preview/layout-fragment-host.rml',
    'internal-preview/layout-fragment-host.rcss',
  ]) {
    if (!(await pathExists(path.join(application.resources, 'editor-assets', required)))) {
      throw new Error(`Packaged editor asset is missing: ${required}`);
    }
  }
  const toolName =
    process.platform === 'win32' ? 'noveltea-editor-tool.exe' : 'noveltea-editor-tool';
  const toolPath = path.join(application.resources, 'bin', toolName);
  const toolInfo = await stat(toolPath);
  if (!toolInfo.isFile() || (process.platform !== 'win32' && (toolInfo.mode & 0o111) === 0)) {
    throw new Error(`Packaged native editor tool is missing or not executable: ${toolPath}`);
  }

  for (const required of ['node_modules/sharp/package.json', 'node_modules/sharp/dist/index.cjs']) {
    if (!(await pathExists(path.join(unpackedRoot, ...required.split('/'))))) {
      throw new Error(`Explicitly unpacked sharp file is missing: ${required}`);
    }
  }
  const nativeClosure = await findSharpNativeClosure(unpackedRoot);

  const fuseWire = await getCurrentFuseWire(application.executable);
  for (const [fuse, expected] of expectedFuses) {
    if (fuseWire[fuse] !== expected) {
      throw new Error(
        `Fuse ${FuseV1Options[fuse]} mismatch: expected ${FuseState[expected]}, received ${FuseState[fuseWire[fuse]] ?? fuseWire[fuse]}.`,
      );
    }
  }

  const result = {
    executable: application.executable,
    resources: application.resources,
    appAsar,
    version: packageMetadata.version,
    asarEntries: entries.length,
    nativeClosure,
    fuses: Object.fromEntries(
      [...expectedFuses].map(([fuse]) => [FuseV1Options[fuse], FuseState[fuseWire[fuse]]]),
    ),
  };
  console.log(`[package-verify] ${JSON.stringify(result, null, 2)}`);
  return result;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  const target = process.argv[2];
  if (!target) throw new Error('Usage: node scripts/verify-packaged-editor.mjs <package-output>');
  await verifyPackagedEditor(target);
}
