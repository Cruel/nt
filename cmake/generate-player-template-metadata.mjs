#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installed = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const version = process.argv[4];
const buildRoot = process.argv[5] ? path.resolve(process.argv[5]) : path.dirname(installed);
if (!process.argv[2] || !process.argv[3] || !version)
  throw new Error('Usage: generate-player-template-metadata.mjs <vcpkg_installed> <stage> <version> [build-root]');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exceptions = JSON.parse(readFileSync(path.join(root, 'cmake/player-license-sources.json'), 'utf8'));
const hash = (data) => createHash('sha256').update(data).digest('hex');
const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const licenseName = /^(?:licen[cs]e|copying|copyright|notice)(?:[._-].*)?$/i;
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const notices = [];
const components = [];
const identifiers = new Set();
const shaFile = (file) => hash(readFileSync(file));
rmSync(path.join(output, 'licenses'), { recursive: true, force: true });

function addComponent(name, componentVersion, sources, provenance) {
  if (!name || !componentVersion || !sources.length)
    throw new Error(`Incomplete required license coverage: ${name} ${componentVersion} (${provenance}).`);
  const id = slug(name);
  if (identifiers.has(id)) throw new Error(`Ambiguous duplicate player dependency '${name}'.`);
  identifiers.add(id);
  const licenseFiles = [];
  const sourceNames = new Set();
  for (const source of sources) {
    const absolute = path.resolve(source);
    if (!existsSync(absolute) || !statSync(absolute).isFile())
      throw new Error(`Required ${name} license source missing: ${absolute}`);
    const data = readFileSync(absolute);
    const rendered = textDecoder.decode(data);
    if (!rendered.trim() ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(rendered) ||
        /No dependency notice file was found|Resolved dependency license texts are collected|PLACEHOLDER LICENSE/i.test(rendered))
      throw new Error(`Required ${name} license contains empty or placeholder text: ${absolute}`);
    let sourceName = slug(path.basename(source)) || 'notice';
    if (sourceNames.has(sourceName))
      sourceName = slug(`${path.basename(path.dirname(source))}-${path.basename(source)}`);
    if (sourceNames.has(sourceName))
      throw new Error(`Ambiguous license source filenames for ${name}: ${source}`);
    sourceNames.add(sourceName);
    const relative = `licenses/${id}--${sourceName}.txt`;
    if (notices.some((entry) => entry.path === relative))
      throw new Error(`Colliding license destination: ${relative}`);
    mkdirSync(path.dirname(path.join(output, relative)), { recursive: true });
    writeFileSync(path.join(output, relative), data);
    licenseFiles.push({ path: relative, size: data.length, sha256: hash(data) });
  }
  notices.push({ component: name, displayName: exceptions.displayNames[name] ?? name, version: componentVersion, files: licenseFiles });
  components.push({ type: 'library', name, version: componentVersion });
}

function pickSources(source, rules, label) {
  if (rules) return rules.map((relative) => relative.startsWith('@repo/')
    ? path.join(root, relative.slice('@repo/'.length)) : path.join(source, relative));
  if (!existsSync(source)) throw new Error(`Missing dependency source tree for ${label}: ${source}`);
  const candidates = readdirSync(source).filter((name) => licenseName.test(name) && statSync(path.join(source, name)).isFile()).sort();
  if (candidates.length === 0)
    throw new Error(`Missing applicable license file for ${label} at ${source}; add a targeted source mapping.`);
  return candidates.map((name) => path.join(source, name));
}

function sourceRevision(source) {
  if (!existsSync(path.join(source, '.git')))
    throw new Error(`Source tree has no own Git revision: ${source}; pin its upstream version explicitly.`);
  try { return execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch {
    throw new Error(`No resolved Git revision for ${source}; record the exact pinned version for this source archive.`);
  }
}

const statusPath = path.join(installed, 'vcpkg', 'status');
if (existsSync(statusPath)) {
  const paragraphs = readFileSync(statusPath, 'utf8').split(/\r?\n\r?\n/);
  const available = paragraphs.map((paragraph) => Object.fromEntries(
    paragraph.split(/\r?\n/).filter((line) => line.includes(': ')).map((line) => {
      const at = line.indexOf(': ');
      return [line.slice(0, at), line.slice(at + 2)];
    }),
  )).filter((item) => item.Package && item.Version && item.Status === 'install ok installed');
  const cache = path.join(buildRoot, 'CMakeCache.txt');
  const cacheText = existsSync(cache) ? readFileSync(cache, 'utf8') : '';
  const triplet = /^VCPKG_TARGET_TRIPLET:[^=]*=(.+)$/m.exec(cacheText)?.[1];
  const triplets = [...new Set(available.filter((item) => !item.Package.startsWith('vcpkg-')).map((item) => item.Architecture))];
  const target = triplet || (triplets.length === 1 ? triplets[0] : null);
  if (!target) throw new Error(`Ambiguous vcpkg target triplet: ${triplets.join(', ')}`);
  const candidates = new Map(available.filter((item) => item.Architecture === target).map((item) => [item.Package, item]));
  const required = new Set();
  function include(name) {
    if (name.startsWith('vcpkg-')) return; // Host-only port helpers, never player runtime code.
    if (required.has(name)) return;
    const item = candidates.get(name);
    if (!item) throw new Error(`Missing installed player dependency ${name} for ${target}`);
    required.add(name);
    for (const dependency of (item.Depends ?? '').split(',').map((value) => value.trim().split(/[:[( ]/)[0]).filter(Boolean))
      if (candidates.has(dependency)) include(dependency);
  }
  for (const name of exceptions.vcpkgRuntimeRoots) include(name);
  if (target.includes('linux'))
    for (const name of exceptions.vcpkgLinuxRoots) include(name);
  const share = path.join(installed, target, 'share');
  for (const name of [...required].sort()) {
    const item = candidates.get(name);
    const source = path.join(share, name, 'copyright');
    addComponent(name, item.Version, [source], `vcpkg:${target}`);
  }
}
const deps = path.join(buildRoot, '_deps');
if (!existsSync(statusPath) && !existsSync(deps))
  throw new Error(`Missing dependency inventory at ${statusPath} and ${deps}`);
if (existsSync(deps)) {
  for (const entry of readdirSync(deps).filter((name) => name.endsWith('-src')).sort()) {
    const source = path.join(deps, entry);
    if (!statSync(source).isDirectory()) continue;
    const name = entry.slice(0, -4);
    const rule = exceptions.fetched[name];
    if (!rule) throw new Error(`Unclassified CMake source dependency ${name}: add a target applicability rule.`);
    if (rule.player === false) continue;
    if (rule.evidence) {
      const evidence = readFileSync(path.join(source, rule.evidence), 'utf8');
      if (!evidence.includes('Permission is hereby granted') ||
          !evidence.includes('Lua.org, PUC-Rio'))
        throw new Error(`Unable to verify license provenance of ${name} from ${rule.evidence}`);
    }
    const revision = rule.version ?? sourceRevision(source);
    if (rule.components) {
      for (const component of rule.components)
        addComponent(component.name, revision, pickSources(source, component.paths, component.name), entry);
    } else {
      addComponent(rule.name ?? name.replaceAll('_src', ''), revision, pickSources(source, rule.paths, name), entry);
    }
  }
}
if (!existsSync(statusPath)) {
  const cache = path.join(buildRoot, 'CMakeCache.txt');
  const cacheText = existsSync(cache) ? readFileSync(cache, 'utf8') : '';
  const emsdkCache = /^EMSDK:[^=]*=(.+)$/m.exec(cacheText)?.[1]?.replaceAll('\\', '/');
  const toolchain = /^CMAKE_TOOLCHAIN_FILE:[^=]*=(.+)$/m.exec(cacheText)?.[1]?.replaceAll('\\', '/');
  const marker = '/upstream/emscripten/';
  const fromToolchain = toolchain?.includes(marker) ? toolchain.slice(0, toolchain.indexOf(marker)) : '';
  const emsdk = emsdkCache || fromToolchain || process.env.EMSDK;
  if (!emsdk) throw new Error('Unable to locate EMSDK to inventory player runtime ports.');
  for (const [name, rule] of Object.entries(exceptions.emscriptenPorts)) {
    const port = path.join(emsdk, 'upstream', 'emscripten', 'cache', 'ports', name);
    if (!existsSync(port)) throw new Error(`Missing required Emscripten port: ${port}`);
    const candidates = readdirSync(port).filter((entry) => statSync(path.join(port, entry)).isDirectory());
    if (candidates.length !== 1) throw new Error(`Ambiguous Emscripten port ${name}: ${candidates.join(', ')}`);
    const source = path.join(port, candidates[0]);
    const match = rule.versionPattern ? new RegExp(rule.versionPattern).exec(candidates[0]) : null;
    if (rule.versionPattern && !match) throw new Error(`Unrecognized Emscripten port source ${source}`);
    addComponent(name, match ? match[1].replaceAll('-', '.') : candidates[0], pickSources(source, rule.paths, name), `emscripten:${name}`);
  }
}

// The bundled system font is a distributed player asset, not a vcpkg dependency.
const font = exceptions.systemFont;
const fontAsset = path.join(root, font.asset);
if (shaFile(fontAsset) !== font.assetSha256)
  throw new Error('Bundled system font changed without updating its license provenance.');
addComponent(font.name, font.version, font.licenses.map((relative) => path.join(root, relative)), font.asset);

notices.sort((a, b) => a.component < b.component ? -1 : a.component > b.component ? 1 : 0);
components.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
if (notices.length !== components.length) throw new Error('SBOM/license component count mismatch.');
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'SBOM.cdx.json'), `${JSON.stringify({
  bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
  metadata: { component: { type: 'application', name: 'noveltea-player', version } }, components,
}, null, 2)}\n`);
writeFileSync(path.join(output, 'licenses', 'index.json'), `${JSON.stringify({
  format: 'noveltea.engine-licenses', components: notices,
}, null, 2)}\n`);
