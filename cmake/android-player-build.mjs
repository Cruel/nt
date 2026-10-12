import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const digest = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

export async function resolveAndroidPlayerBuild(root, abi, flavor) {
  if (!['debug', 'release'].includes(flavor)) throw new Error(`Unsupported Android flavor: ${flavor}`);
  if (!['x86_64', 'arm64-v8a'].includes(abi)) throw new Error(`Unsupported Android ABI: ${abi}`);
  const app = path.join(root, 'android', 'app');
  const capitalizedFlavor = flavor[0].toUpperCase() + flavor.slice(1);
  // AGP's merge task owns the current native closure; sibling directories may be stale caches.
  const nativeRoot = path.join(app, 'build', 'intermediates', 'merged_native_libs', flavor,
    `merge${capitalizedFlavor}NativeLibs`, 'out', 'lib', abi);
  const library = 'libnoveltea-player.so';
  const expectedDigest = await digest(path.join(nativeRoot, library));
  const cxx = path.join(app, '.cxx');
  const matches = [];
  const configurations = flavor === 'debug' ? ['debug'] : ['release', 'relwithdebinfo', 'minsizerel'];
  for (const variant of await readdir(cxx, { withFileTypes: true })) {
    if (!variant.isDirectory() || !configurations.includes(variant.name.toLowerCase())) continue;
    for (const configuration of await readdir(path.join(cxx, variant.name), { withFileTypes: true })) {
      if (!configuration.isDirectory()) continue;
      const buildRoot = path.join(cxx, variant.name, configuration.name, abi);
      const nativeLibraryPath = path.join(app, 'build', 'intermediates', 'cxx', variant.name,
        configuration.name, 'obj', abi, library);
      let cache;
      try {
        await stat(path.join(buildRoot, 'CMakeCache.txt'));
        await stat(nativeLibraryPath);
        cache = await readFile(path.join(buildRoot, 'CMakeCache.txt'), 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const buildType = /^CMAKE_BUILD_TYPE:[^=]*=(.*)$/m.exec(cache)?.[1]?.trim().toLowerCase();
      if (!configurations.includes(buildType)) continue;
      if (await digest(nativeLibraryPath) === expectedDigest) matches.push({ buildRoot, nativeLibraryPath });
    }
  }
  if (matches.length !== 1)
    throw new Error(`Expected one Android ${flavor}/${abi} CMake build matching the current merged player library, found ${matches.length}. Rebuild the Android player before packaging.`);
  return { nativeRoot, ...matches[0] };
}
