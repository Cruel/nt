import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateAppIcons } from './icon-generation-service';
import { buildPlatformDeployment } from '../../shared/project-schema/platform-deployment';
import { parseTemplateDescriptor, PLATFORM_EXPORT_MANIFEST_FORMAT, PLATFORM_EXPORT_MANIFEST_FORMAT_VERSION, type PlatformExportManifest, type PlatformStageDiagnostic, type PlatformStageRequest, type PlatformStageResult, type StagedFileEntry, type StagedFileOrigin } from '../../shared/project-schema/platform-export-contracts';
import { validateTargetPaths } from '../../shared/project-schema/target-path-portability';

const cancellations = new Set<string>();
const descriptorName = 'template.json';
const forbidden = /(^|\/)(?:sandbox|demo)(?:\/|$)/i;
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
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

export async function stagePlatformExport(request: PlatformStageRequest): Promise<PlatformStageResult> {
  const diagnostics: PlatformStageDiagnostic[] = [];
  const temp = `${request.outputDirectory}.tmp-${request.operationId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const backup = `${request.outputDirectory}.previous-${request.operationId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  let backedUp = false;
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
    const descriptorPath = path.join(request.templateRoot, descriptorName);
    if (!existsSync(descriptorPath)) return { ok: false, success: false, cancelled: false, operationId: request.operationId, diagnostics: [diagnostic('missing-template', '/templateRoot', `Template must contain ${descriptorName}.`)] };
    const descriptor = parseTemplateDescriptor(JSON.parse(await readFile(descriptorPath, 'utf8')));
    const built = buildPlatformDeployment(request, descriptor); diagnostics.push(...built.diagnostics);
    if (!built.model) return { ok: false, success: false, cancelled: false, operationId: request.operationId, diagnostics };
    if (!existsSync(request.packagePath)) diagnostics.push(diagnostic('missing-package', '/packagePath', 'Runtime package does not exist.'));
    if (!request.iconSourcePath) diagnostics.push(diagnostic('missing-icon', '/iconSourcePath', 'Application icon is required for platform staging.'));
    else if (!existsSync(request.iconSourcePath)) diagnostics.push(diagnostic('missing-icon', '/iconSourcePath', 'Application icon does not exist.'));
    const templateFiles = (await listFiles(request.templateRoot)).filter((file) => file !== descriptorName);
    for (const file of templateFiles) if (forbidden.test(file)) diagnostics.push(diagnostic('sandbox-content', `/template/${file}`, `Sandbox/demo content '${file}' is forbidden.`));
    for (const dependency of descriptor.runtimeDependencies) if (!templateFiles.includes(dependency.path)) diagnostics.push(diagnostic('missing-template-dependency', `/template/${dependency.path}`, `Declared template dependency '${dependency.path}' is missing.`));
    const prospective = [...templateFiles.map((targetPath) => ({ sourceId: `template:${targetPath}`, targetPath })), { sourceId: 'runtime-package', targetPath: 'game.ntpkg' }];
    diagnostics.push(...validateTargetPaths(prospective, request.profile.target).map((item) => diagnostic(item.code, '/staging', item.message)));
    if (diagnostics.some((item) => item.severity === 'error')) return { ok: false, success: false, cancelled: false, operationId: request.operationId, diagnostics, deployment: built.model };
    let estimated = (await stat(request.packagePath)).size;
    for (const file of templateFiles) estimated += (await stat(safeRoot(request.templateRoot, file))).size;
    const disk = await statfs(path.dirname(path.resolve(request.outputDirectory))); if (Number(disk.bavail) * Number(disk.bsize) < estimated * 2) return { ok: false, success: false, cancelled: false, operationId: request.operationId, diagnostics: [diagnostic('insufficient-disk-space', '/outputDirectory', 'Not enough disk space to build and atomically replace staging output.')], deployment: built.model };
    await rm(temp, { recursive: true, force: true }); await rm(backup, { recursive: true, force: true }); await mkdir(temp, { recursive: true });
    const files: StagedFileEntry[] = []; const dependencyKinds = new Map(descriptor.runtimeDependencies.map((item) => [item.path, item.kind === 'notice' ? 'notice' as const : item.kind === 'library' ? 'native-dependency' as const : 'system-asset' as const]));
    for (const file of templateFiles) { checkCancelled(request.operationId); files.push(await copyFileTracked(safeRoot(request.templateRoot, file), temp, file, classifyTemplate(file, dependencyKinds), `template:${descriptor.templateId}`)); }
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
    const packageEntry = files.find((item) => item.origin === 'runtime-package')!;
    const player = { format: 'noveltea.player-config', formatVersion: 1, displayName: built.model.displayName, applicationId: built.model.applicationId, saveNamespace: built.model.saveNamespace, versionName: built.model.versionName, ...(request.identity.defaultLocale ? { defaultLocale: request.identity.defaultLocale } : {}), package: { path: 'game.ntpkg', sha256: packageEntry.sha256, runtimePackageApi: request.runtimePackageApi }, capabilities: built.model.capabilities, display: built.model.display };
    const playerData = Buffer.from(`${JSON.stringify(player, null, 2)}\n`); await writeFile(path.join(temp, 'player.json'), playerData); files.push({ path: 'player.json', origin: 'generated-metadata', originId: 'player-config', size: playerData.length, mode: 0o644, sha256: sha256(playerData) });
    files.sort((a, b) => a.path.localeCompare(b.path));
    const manifest: PlatformExportManifest = { format: PLATFORM_EXPORT_MANIFEST_FORMAT, formatVersion: PLATFORM_EXPORT_MANIFEST_FORMAT_VERSION, deployment: built.model, files };
    await writeFile(path.join(temp, 'export-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 }); checkCancelled(request.operationId);
    if (existsSync(request.outputDirectory)) { await rename(request.outputDirectory, backup); backedUp = true; }
    await rename(temp, request.outputDirectory); if (backedUp) await rm(backup, { recursive: true, force: true });
    return { ok: true, success: true, cancelled: false, operationId: request.operationId, outputDirectory: request.outputDirectory, diagnostics, deployment: built.model, manifest };
  } catch (error) {
    const cancelled = error instanceof Error && error.message === 'NOVELTEA_EXPORT_CANCELLED';
    if (!cancelled && !(error instanceof Error && error.message === 'NOVELTEA_EXPORT_DIAGNOSTIC')) diagnostics.push(diagnostic('staging-failed', '/staging', error instanceof Error ? error.message : String(error)));
    await rm(temp, { recursive: true, force: true });
    if (backedUp && !existsSync(request.outputDirectory) && existsSync(backup)) await rename(backup, request.outputDirectory);
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
