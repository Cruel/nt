import { chmod, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

async function pathExists(target) {
  try {
    await readFile(target);
    return true;
  } catch {
    return false;
  }
}

export function nodePtyTuple(platform, arch) {
  return `${platform}-${arch}`;
}

export async function pruneForeignNodePtyPrebuilds(nodePtyRoot, platform, arch) {
  const prebuildsRoot = path.join(nodePtyRoot, 'prebuilds');
  let entries;
  try {
    entries = await readdir(prebuildsRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw error;
  }
  const currentTuple = nodePtyTuple(platform, arch);
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== currentTuple)
      .map((entry) => rm(path.join(prebuildsRoot, entry.name), { recursive: true, force: true })),
  );
  if (platform === 'darwin') {
    try {
      await chmod(path.join(prebuildsRoot, currentTuple, 'spawn-helper'), 0o755);
    } catch (error) {
      if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error;
    }
  }
}

export async function inspectNodePtyNativeClosure(nodePtyRoot, platform, arch, expectedVersion) {
  const packageMetadataPath = path.join(nodePtyRoot, 'package.json');
  let metadata;
  try {
    metadata = JSON.parse(await readFile(packageMetadataPath, 'utf8'));
  } catch {
    throw new Error('Unpacked node-pty package metadata is missing or invalid.');
  }
  if (metadata.name !== 'node-pty' || metadata.version !== expectedVersion) {
    throw new Error(
      `Unexpected node-pty package identity: ${JSON.stringify({ name: metadata.name, version: metadata.version })}.`,
    );
  }

  const currentTuple = nodePtyTuple(platform, arch);
  const prebuildsRoot = path.join(nodePtyRoot, 'prebuilds');
  let prebuildEntries = [];
  try {
    prebuildEntries = await readdir(prebuildsRoot, { withFileTypes: true });
  } catch (error) {
    if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error;
  }
  const foreign = prebuildEntries
    .filter((entry) => entry.isDirectory() && entry.name !== currentTuple)
    .map((entry) => entry.name)
    .sort();
  if (foreign.length > 0) {
    throw new Error(`Found foreign node-pty native artifact tuple(s): ${foreign.join(', ')}.`);
  }

  const bindingName = platform === 'win32' ? 'conpty.node' : 'pty.node';
  const candidates = [
    path.join(nodePtyRoot, 'build', 'Release', bindingName),
    path.join(nodePtyRoot, 'prebuilds', currentTuple, bindingName),
  ];
  const binding = await firstExistingFile(candidates);
  if (!binding) {
    throw new Error(
      `Packaged node-pty closure is missing the required node-pty native binding ${bindingName} for ${currentTuple}.`,
    );
  }

  let spawnHelper = null;
  if (platform === 'darwin') {
    spawnHelper = path.join(nodePtyRoot, 'prebuilds', currentTuple, 'spawn-helper');
    let helperStat;
    try {
      helperStat = await stat(spawnHelper);
    } catch {
      throw new Error(
        `Packaged node-pty closure is missing the required macOS spawn-helper for ${currentTuple}.`,
      );
    }
    if (!helperStat.isFile() || (helperStat.mode & 0o111) === 0) {
      throw new Error(
        `Packaged node-pty macOS spawn-helper is not executable for ${currentTuple}.`,
      );
    }
  }

  return {
    root: nodePtyRoot,
    tuple: currentTuple,
    binding,
    spawnHelper,
    version: metadata.version,
  };
}

async function firstExistingFile(candidates) {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}
