import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { generateAppIcons } from './icon-generation-service';
import { buildPlatformDeployment } from '../../shared/project-schema/platform-deployment';
import { PLATFORM_EXPORT_MANIFEST_FORMAT, PLATFORM_EXPORT_MANIFEST_FORMAT_VERSION, type PlatformExportManifest, type PlatformStageDiagnostic, type PlatformStageRequest, type PlatformStageResult, type StagedFileEntry, type StagedFileOrigin } from '../../shared/project-schema/platform-export-contracts';
import { validateTargetPaths } from '../../shared/project-schema/target-path-portability';
import { templateRootForToken, verifyTemplateToken } from './template-registry-service';

const cancellations = new Set<string>();
const descriptorName = 'template.json';
const forbidden = /(^|\/)(?:sandbox|demo)(?:\/|$)/i;
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const run = promisify(execFile);
const diagnostic = (code: string, pathValue: string, message: string): PlatformStageDiagnostic => ({ severity: 'error', code, path: pathValue, message });

export function cancelPlatformExport(operationId: string) { cancellations.add(operationId); return { cancelled: true }; }
function checkCancelled(operationId: string) { if (cancellations.has(operationId)) throw new Error('NOVELTEA_EXPORT_CANCELLED'); }
function safeRoot(root: string, relative: string) { const resolved = path.resolve(root, relative); if (resolved !== path.resolve(root) && !resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`Path '${relative}' escapes its root.`); return resolved; }
async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(safeRoot(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix.split(path.sep).join('/'), entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link '${relative}' is not allowed in export inputs.`);
    if (entry.isDirectory()) output.push(...await listFiles(root, relative)); else if (entry.isFile()) output.push(relative);
  }
  return output.sort();
}
async function copyFileTracked(source: string, stage: string, target: string, origin: StagedFileOrigin, originId: string): Promise<StagedFileEntry> {
  const info = await lstat(source); if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Export input '${source}' is not a regular file.`);
  const data = await readFile(source); const destination = safeRoot(stage, target); await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, data, { mode: info.mode & 0o777 });
  return { path: target.split(path.sep).join('/'), origin, originId, size: data.length, mode: info.mode & 0o777, sha256: sha256(data) };
}
function classifyTemplate(relative: string, dependencyKinds: Map<string, StagedFileOrigin>): StagedFileOrigin { return dependencyKinds.get(relative) ?? 'template'; }

function htmlEscape(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

async function writeGenerated(stage: string, target: string, data: string | Buffer, originId: string): Promise<StagedFileEntry> {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const destination = safeRoot(stage, target);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, buffer, { mode: 0o644 });
  return { path: target, origin: 'generated-metadata', originId, size: buffer.length, mode: 0o644, sha256: sha256(buffer) };
}

async function finalizeWebStage(stage: string, request: PlatformStageRequest, files: StagedFileEntry[]) {
  if (request.profile.target !== 'web') return undefined;
  const profile = request.profile.web;
  const find = (suffix: string) => files.find((item) => item.path === suffix || item.path.endsWith(`/${suffix}`));
  const script = find('player.js');
  const wasm = find('player.wasm');
  const data = find('player.data');
  const packageEntry = files.find((item) => item.origin === 'runtime-package');
  if (!script || !wasm || !data || !packageEntry) throw new Error('Web template must contain player.js, player.wasm, and player.data plus the runtime package.');

  for (const entry of [script, wasm, data, packageEntry]) {
    const extension = path.posix.extname(entry.path);
    const stem = path.posix.basename(entry.path, extension);
    const target = `${stem}.${entry.sha256.slice(0, 16)}${extension}`;
    await rename(safeRoot(stage, entry.path), safeRoot(stage, target));
    entry.path = target;
  }

  const basePath = profile.basePath;
  const manifestId = request.identity.webManifestId ?? `/${encodeURIComponent(request.identity.applicationId)}`;
  const shortName = request.identity.shortName ?? request.identity.displayName;
  const themeColor = request.identity.themeColor ?? '#111827';
  const backgroundColor = request.identity.backgroundColor ?? '#000000';
  const allWebIcons = files.filter((item) => item.origin === 'icon');
  for (const entry of allWebIcons) {
    const extension = path.posix.extname(entry.path);
    const directory = path.posix.dirname(entry.path);
    const stem = path.posix.basename(entry.path, extension);
    const target = path.posix.join(directory, `${stem}.${entry.sha256.slice(0, 16)}${extension}`);
    await rename(safeRoot(stage, entry.path), safeRoot(stage, target));
    entry.path = target;
  }
  const iconEntries = allWebIcons.filter((item) => /icon-(192|512)\.[0-9a-f]{16}\.png$/.test(item.path));
  const icon = (size: number) => iconEntries.find((item) => new RegExp(`icon-${size}\\.[0-9a-f]{16}\\.png$`).test(item.path))?.path;
  const webManifest = {
    id: manifestId,
    name: request.identity.displayName,
    short_name: shortName,
    start_url: basePath,
    scope: basePath,
    display: profile.display,
    orientation: request.display.orientation,
    theme_color: themeColor,
    background_color: backgroundColor,
    ...(request.identity.defaultLocale ? { lang: request.identity.defaultLocale } : {}),
    icons: [192, 512].flatMap((size) => icon(size) ? [{ src: `${basePath}${icon(size)}`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any maskable' }] : []),
  };
  files.push(await writeGenerated(stage, 'manifest.webmanifest', `${JSON.stringify(webManifest, null, 2)}\n`, 'web-manifest'));

  const immutable = [script.path, wasm.path, data.path, packageEntry.path, ...allWebIcons.map((item) => item.path)];
  const exportHash = sha256(Buffer.from(immutable.map((item) => files.find((file) => file.path === item)?.sha256 ?? '').join(''))).slice(0, 20);
  const cachePrefix = `noveltea-${request.identity.applicationId.replace(/[^a-zA-Z0-9._-]/g, '_')}-`;
  const serviceWorker = profile.pwa && profile.serviceWorker === 'offline' ? `
const CACHE = ${JSON.stringify(`${cachePrefix}${exportHash}`)};
const PREFIX = ${JSON.stringify(cachePrefix)};
const ASSETS = ${JSON.stringify(['./', './index.html', './player.json', './manifest.webmanifest', ...immutable.map((item) => `./${item}`)])};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => { if (event.request.method === 'GET') event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request))); });
` : '';
  if (serviceWorker) files.push(await writeGenerated(stage, 'service-worker.js', serviceWorker.trimStart(), 'web-service-worker'));

  const favicon = allWebIcons.find((item) => /favicon\.[0-9a-f]{16}\.ico$/.test(item.path))?.path;
  const index = `<!doctype html>
<html lang="${htmlEscape(request.identity.defaultLocale ?? 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${htmlEscape(request.identity.displayName)}</title><link rel="manifest" href="${basePath}manifest.webmanifest">${favicon ? `<link rel="icon" href="${basePath}${favicon}">` : ''}<meta name="theme-color" content="${themeColor}"><style>html,body,#canvas{width:100%;height:100%;margin:0;background:${backgroundColor}}body{overflow:hidden;font-family:system-ui,sans-serif}#launch,#failure{position:fixed;inset:0;display:grid;place-content:center;text-align:center;padding:2rem;background:${backgroundColor};color:white;z-index:2}#failure{display:none}button{font:inherit;padding:.8rem 1.2rem}</style></head><body><canvas id="canvas" tabindex="-1"></canvas><div id="launch"><h1>${htmlEscape(request.identity.displayName)}</h1><button id="start">Start</button></div><div id="failure"><h1>Unable to start</h1><p id="failure-message"></p></div><script>
const fail=m=>{document.getElementById('launch').style.display='none';document.getElementById('failure').style.display='grid';document.getElementById('failure-message').textContent=m};
if(!window.WebAssembly||!document.createElement('canvas').getContext('webgl2')) fail('This browser does not support WebAssembly and WebGL 2.');
document.getElementById('start').addEventListener('click',()=>{document.getElementById('launch').style.display='none';window.Module={canvas:document.getElementById('canvas'),locateFile:p=>p==='player.wasm'?${JSON.stringify(`${basePath}${wasm.path}`)}:p==='player.data'?${JSON.stringify(`${basePath}${data.path}`)}:basePath+p,onNovelTeaStartupError:fail};const s=document.createElement('script');s.src=${JSON.stringify(`${basePath}${script.path}`)};s.onerror=()=>fail('The player could not be downloaded.');document.body.appendChild(s)});
${serviceWorker ? `if('serviceWorker' in navigator) navigator.serviceWorker.register(${JSON.stringify(`${basePath}service-worker.js`)}, {scope:${JSON.stringify(basePath)}}).catch(error=>console.warn('[service-worker]',error));` : ''}
</script></body></html>\n`;
  files.push(await writeGenerated(stage, 'index.html', index, 'web-shell'));
  const deployment = `# Web deployment\n\nServe this directory over HTTPS (localhost is also accepted by browsers). Opening index.html through file:// is unsupported.\n\nBase path: \`${basePath}\`\n\nRequired MIME types:\n- .wasm: application/wasm\n- .js: text/javascript\n- .ntpkg: application/octet-stream\n- .webmanifest: application/manifest+json\n\nUse long-lived immutable caching for content-hashed .js, .wasm, .ntpkg, and icon files. Serve index.html, player.json, and manifest.webmanifest with revalidation. Enable Brotli or gzip compression for JavaScript and Wasm.\n\nHTTPS required: ${profile.pwa ? 'yes (PWA/service-worker behavior)' : 'recommended'}\nService worker: ${serviceWorker ? 'offline cache enabled' : 'disabled'}\nCross-origin isolation: ${profile.threaded ? 'required; send COOP: same-origin and COEP: require-corp' : 'not required'}\n`;
  files.push(await writeGenerated(stage, 'DEPLOYMENT.md', deployment, 'web-deployment'));

  const downloadable = await Promise.all([script, wasm, data, packageEntry].map(async (entry) => readFile(safeRoot(stage, entry.path))));
  return {
    compressedDownloadBytes: downloadable.reduce((sum, data) => sum + gzipSync(data).length, 0),
    uncompressedPackageBytes: packageEntry.size,
    estimatedPeakStartupBytes: packageEntry.size * 2 + wasm.size + data.size,
  };
}

export async function stagePlatformExport(request: PlatformStageRequest): Promise<PlatformStageResult> {
  const diagnostics: PlatformStageDiagnostic[] = [];
  const temp = `${request.outputDirectory}.tmp-${request.operationId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const backup = `${request.outputDirectory}.previous-${request.operationId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const archivePath = request.profile.target === 'web' ? `${request.outputDirectory}.zip` : undefined;
  const archiveTemp = archivePath ? `${archivePath}.tmp-${request.operationId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : undefined;
  const archiveBackup = archivePath ? `${archivePath}.previous-${request.operationId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : undefined;
  let backedUp = false;
  let archiveBackedUp = false;
  try {
    cancellations.delete(request.operationId); checkCancelled(request.operationId);
    if (request.runtimePackageReadiness?.validated !== true || request.runtimePackageReadiness.blockingDiagnosticCount !== 0) {
      return {
        ok: false,
        success: false,
        cancelled: false,
        operationId: request.operationId,
        diagnostics: [diagnostic(
          'runtime-package-not-ready',
          '/runtimePackageReadiness',
          'Platform staging requires a runtime package produced by a successful validation and conversion workflow with no blocking diagnostics.',
        )],
      };
    }
    let descriptor;
    let templateRoot;
    try { templateRoot = templateRootForToken(request.templateToken); ({ descriptor } = await verifyTemplateToken(request.templateToken)); }
    catch (error) { return { ok: false, success: false, cancelled: false, operationId: request.operationId, diagnostics: [diagnostic('invalid-installed-template', '/templateToken', error instanceof Error ? error.message : String(error))] }; }
    const built = buildPlatformDeployment(request, descriptor); diagnostics.push(...built.diagnostics);
    if (!built.model) return { ok: false, success: false, cancelled: false, operationId: request.operationId, diagnostics };
    if (!existsSync(request.packagePath)) diagnostics.push(diagnostic('missing-package', '/packagePath', 'Runtime package does not exist.'));
    if (!request.iconSourcePath) diagnostics.push(diagnostic('missing-icon', '/iconSourcePath', 'Application icon is required for platform staging.'));
    else if (!existsSync(request.iconSourcePath)) diagnostics.push(diagnostic('missing-icon', '/iconSourcePath', 'Application icon does not exist.'));
    const templateFiles = (await listFiles(templateRoot)).filter((file) => file !== descriptorName && file !== '.noveltea-template.json');
    for (const file of templateFiles) if (forbidden.test(file)) diagnostics.push(diagnostic('sandbox-content', `/template/${file}`, `Sandbox/demo content '${file}' is forbidden.`));
    for (const dependency of descriptor.runtimeDependencies) if (!templateFiles.includes(dependency.path)) diagnostics.push(diagnostic('missing-template-dependency', `/template/${dependency.path}`, `Declared template dependency '${dependency.path}' is missing.`));
    const prospective = [...templateFiles.map((targetPath) => ({ sourceId: `template:${targetPath}`, targetPath })), { sourceId: 'runtime-package', targetPath: 'game.ntpkg' }];
    diagnostics.push(...validateTargetPaths(prospective, request.profile.target).map((item) => diagnostic(item.code, '/staging', item.message)));
    if (diagnostics.some((item) => item.severity === 'error')) return { ok: false, success: false, cancelled: false, operationId: request.operationId, diagnostics, deployment: built.model };
    let estimated = (await stat(request.packagePath)).size;
    for (const file of templateFiles) estimated += (await stat(safeRoot(templateRoot, file))).size;
    const disk = await statfs(path.dirname(path.resolve(request.outputDirectory))); if (Number(disk.bavail) * Number(disk.bsize) < estimated * 2) return { ok: false, success: false, cancelled: false, operationId: request.operationId, diagnostics: [diagnostic('insufficient-disk-space', '/outputDirectory', 'Not enough disk space to build and atomically replace staging output.')], deployment: built.model };
    await rm(temp, { recursive: true, force: true }); await rm(backup, { recursive: true, force: true }); await mkdir(temp, { recursive: true });
    const files: StagedFileEntry[] = []; const dependencyKinds = new Map(descriptor.runtimeDependencies.map((item) => [item.path, item.kind === 'notice' ? 'notice' as const : item.kind === 'library' ? 'native-dependency' as const : 'system-asset' as const]));
    for (const file of templateFiles) { checkCancelled(request.operationId); files.push(await copyFileTracked(safeRoot(templateRoot, file), temp, file, classifyTemplate(file, dependencyKinds), `template:${descriptor.templateId}`)); }
    files.push(await copyFileTracked(request.packagePath, temp, 'game.ntpkg', 'runtime-package', 'game.ntpkg'));
    if (request.systemAssetsRoot) for (const file of await listFiles(request.systemAssetsRoot)) { checkCancelled(request.operationId); files.push(await copyFileTracked(safeRoot(request.systemAssetsRoot, file), temp, path.posix.join('assets/system', file), 'system-asset', file)); }
    checkCancelled(request.operationId);
    const iconResult = await generateAppIcons({ sourcePath: request.iconSourcePath!, stagingRoot: path.join(temp, '.icons'), platforms: [request.profile.target === 'web' || request.profile.target === 'linux' ? 'web' : request.profile.target === 'android' ? 'android' : request.profile.target === 'windows' ? 'windows' : 'macos'] });
    diagnostics.push(...iconResult.diagnostics.map((item) => ({ severity: item.severity, code: item.code, path: '/icon', message: item.message })));
    const iconTargets = iconResult.files.map((icon) => path.posix.join('icons', path.relative(path.join(temp, '.icons'), icon.path).split(path.sep).join('/')));
    const allTargets = [...files.map((item) => ({ sourceId: item.originId, targetPath: item.path })), ...iconTargets.map((targetPath) => ({ sourceId: `icon:${targetPath}`, targetPath })), { sourceId: 'player-config', targetPath: 'player.json' }, { sourceId: 'export-manifest', targetPath: 'export-manifest.json' }];
    diagnostics.push(...validateTargetPaths(allTargets, request.profile.target).map((item) => diagnostic(item.code, '/staging', item.message)));
    if (diagnostics.some((item) => item.severity === 'error')) throw new Error('NOVELTEA_EXPORT_DIAGNOSTIC');
    for (let index = 0; index < iconResult.files.length; index += 1) { const icon = iconResult.files[index]!; files.push(await copyFileTracked(icon.path, temp, iconTargets[index]!, 'icon', icon.kind)); }
    await rm(path.join(temp, '.icons'), { recursive: true, force: true });
    const webMetrics = await finalizeWebStage(temp, request, files);
    const packageEntry = files.find((item) => item.origin === 'runtime-package')!;
    const player = { format: 'noveltea.player-config', formatVersion: 1, displayName: built.model.displayName, applicationId: built.model.applicationId, saveNamespace: built.model.saveNamespace, versionName: built.model.versionName, ...(request.identity.defaultLocale ? { defaultLocale: request.identity.defaultLocale } : {}), package: { path: packageEntry.path, sha256: packageEntry.sha256, runtimePackageApi: request.runtimePackageApi }, capabilities: built.model.capabilities, display: built.model.display };
    const playerData = Buffer.from(`${JSON.stringify(player, null, 2)}\n`); await writeFile(path.join(temp, 'player.json'), playerData); files.push({ path: 'player.json', origin: 'generated-metadata', originId: 'player-config', size: playerData.length, mode: 0o644, sha256: sha256(playerData) });
    files.sort((a, b) => a.path.localeCompare(b.path));
    const manifest: PlatformExportManifest = { format: PLATFORM_EXPORT_MANIFEST_FORMAT, formatVersion: PLATFORM_EXPORT_MANIFEST_FORMAT_VERSION, deployment: built.model, files };
    await writeFile(path.join(temp, 'export-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 }); checkCancelled(request.operationId);
    if (archivePath && archiveTemp) {
      await rm(archiveTemp, { force: true });
      await run('cmake', ['-E', 'tar', 'cf', archiveTemp, '--format=zip', '.'], { cwd: temp });
      checkCancelled(request.operationId);
    }
    if (existsSync(request.outputDirectory)) { await rename(request.outputDirectory, backup); backedUp = true; }
    if (archivePath && archiveBackup && existsSync(archivePath)) { await rename(archivePath, archiveBackup); archiveBackedUp = true; }
    try {
      await rename(temp, request.outputDirectory);
      if (archivePath && archiveTemp) await rename(archiveTemp, archivePath);
    } catch (error) {
      await rm(request.outputDirectory, { recursive: true, force: true });
      if (archivePath) await rm(archivePath, { force: true });
      if (backedUp && existsSync(backup)) await rename(backup, request.outputDirectory);
      if (archiveBackedUp && archiveBackup && existsSync(archiveBackup)) await rename(archiveBackup, archivePath!);
      throw error;
    }
    if (backedUp) await rm(backup, { recursive: true, force: true });
    if (archiveBackedUp && archiveBackup) await rm(archiveBackup, { force: true });
    return { ok: true, success: true, cancelled: false, operationId: request.operationId, outputDirectory: request.outputDirectory, archivePath, webMetrics, diagnostics, deployment: built.model, manifest };
  } catch (error) {
    const cancelled = error instanceof Error && error.message === 'NOVELTEA_EXPORT_CANCELLED';
    if (!cancelled && !(error instanceof Error && error.message === 'NOVELTEA_EXPORT_DIAGNOSTIC')) diagnostics.push(diagnostic('staging-failed', '/staging', error instanceof Error ? error.message : String(error)));
    await rm(temp, { recursive: true, force: true });
    if (archiveTemp) await rm(archiveTemp, { force: true });
    if (backedUp && !existsSync(request.outputDirectory) && existsSync(backup)) await rename(backup, request.outputDirectory);
    if (archivePath && archiveBackedUp && archiveBackup && !existsSync(archivePath) && existsSync(archiveBackup)) await rename(archiveBackup, archivePath);
    return { ok: false, success: false, cancelled, operationId: request.operationId, diagnostics: cancelled ? [...diagnostics, { severity: 'info', code: 'cancelled', path: '/staging', message: 'Platform export was cancelled.' }] : diagnostics };
  } finally { cancellations.delete(request.operationId); }
}

export function redactPlatformStageResult(value: unknown): unknown {
  const sensitive = /(?:path|directory|root|secret|password|credential|keystore|certificate)/i;
  const visit = (item: unknown, key = ''): unknown => {
    if (sensitive.test(key)) return '<redacted>';
    if (Array.isArray(item)) return item.map((entry) => visit(entry));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, visit(entry, name)]));
    return item;
  };
  return visit(value);
}
