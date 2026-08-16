import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const installed = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const version = process.argv[4];
const statusPath = path.join(installed, 'vcpkg', 'status');
const buildRoot = process.argv[5] ? path.resolve(process.argv[5]) : path.dirname(installed);
let packages;
if (existsSync(statusPath)) {
  packages = readFileSync(statusPath, 'utf8').split(/\r?\n\r?\n/).map((paragraph) => Object.fromEntries(paragraph.split(/\r?\n/).filter((line) => line.includes(': ')).map((line) => { const at = line.indexOf(': '); return [line.slice(0, at), line.slice(at + 2)]; }))).filter((item) => item.Package && item.Version && item.Status?.endsWith(' installed')).sort((a, b) => a.Package.localeCompare(b.Package));
} else {
  const deps = path.join(buildRoot, '_deps');
  if (!existsSync(deps)) throw new Error(`Missing dependency inventory at ${statusPath} and ${deps}`);
  packages = readdirSync(deps).filter((name) => name.endsWith('-src') && statSync(path.join(deps, name)).isDirectory()).sort().map((name) => {
    const source = path.join(deps, name); let revision = 'source-tree';
    try { revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* source archive without Git metadata */ }
    return { Package: name.slice(0, -4), Version: revision, Source: source };
  });

  // Emscripten ports live outside CMake's _deps tree, so add the runtime ports that
  // NovelTea requests explicitly and require their fetched license sources to exist.
  const cachePath = path.join(buildRoot, 'CMakeCache.txt');
  const cacheText = existsSync(cachePath) ? readFileSync(cachePath, 'utf8') : '';
  const cachedEmsdk = /^EMSDK:[^=]*=(.+)$/m.exec(cacheText)?.[1]?.replaceAll('\\', '/');
  const toolchain = /^CMAKE_TOOLCHAIN_FILE:[^=]*=(.+)$/m.exec(cacheText)?.[1]?.replaceAll('\\', '/');
  const installPrefix = /^CMAKE_INSTALL_PREFIX:[^=]*=(.+)$/m.exec(cacheText)?.[1]?.replaceAll('\\', '/');
  const marker = '/upstream/emscripten/';
  const configuredEmscriptenPath = [toolchain, installPrefix].find((value) => value?.includes(marker));
  const configuredEmsdk = configuredEmscriptenPath ? configuredEmscriptenPath.slice(0, configuredEmscriptenPath.indexOf(marker)) : '';
  const emsdk = cachedEmsdk || configuredEmsdk || process.env.EMSDK || '';
  if (!emsdk) throw new Error('Unable to locate EMSDK to inventory Emscripten runtime ports.');
  for (const [name, version] of [['libpng', '1.6.58'], ['zlib', '1.3.2']]) {
    const source = path.join(emsdk, 'upstream', 'emscripten', 'cache', 'ports', name, `${name}-${version}`);
    if (!existsSync(source)) throw new Error(`Missing fetched Emscripten port source for ${name} ${version}: ${source}`);
    if (!packages.some((item) => item.Package === name)) packages.push({ Package: name, Version: version, Source: source });
  }
  packages.sort((a, b) => a.Package.localeCompare(b.Package));
}
const components = packages.map((item) => ({ type: 'library', name: item.Package, version: item.Version, ...(item.Architecture ? { properties: [{ name: 'vcpkg:architecture', value: item.Architecture }] } : {}) }));
writeFileSync(path.join(output, 'SBOM.cdx.json'), `${JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, metadata: { component: { type: 'application', name: 'noveltea-player', version } }, components }, null, 2)}\n`);
const share = path.join(installed, 'share'); const notices = ['NovelTea player third-party notices', ''];
for (const item of packages) {
  const copyright = path.join(share, item.Package, 'copyright');
  const sourceLicenses = item.Source ? readdirSync(item.Source).filter((name) => /^(?:licen[cs]e|copying|copyright|notice)(?:\..*)?$/i.test(name)).sort() : [];
  notices.push(`===== ${item.Package} ${item.Version} =====`);
  if (existsSync(copyright)) notices.push(readFileSync(copyright, 'utf8').trim());
  else if (sourceLicenses.length) for (const name of sourceLicenses) notices.push(readFileSync(path.join(item.Source, name), 'utf8').trim());
  else notices.push('No dependency notice file was found in the resolved source tree.');
  notices.push('');
}
writeFileSync(path.join(output, 'licenses', 'THIRD_PARTY_NOTICES.txt'), `${notices.join('\n')}\n`);
