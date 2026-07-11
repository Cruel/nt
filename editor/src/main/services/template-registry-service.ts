import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseTemplateDescriptor, templateCompatibilityRequirementsSchema, templateRegistryEntrySchema, type InstalledTemplate, type TemplateCompatibilityDiagnostic, type TemplateInstallRequest, type TemplateInstallResult, type TemplateRegistryEntry, type TemplateRegistryQuery, type TemplateResolveRequest, type TemplateResolveResult } from '../../shared/project-schema/platform-export-contracts';
import { evaluateTemplateCompatibility } from '../../shared/project-schema/template-compatibility';

const run = promisify(execFile);
const descriptorFile = 'template.json';
const recordFile = '.noveltea-template.json';
const maxArchiveBytes = 2 * 1024 * 1024 * 1024;
const maxExpandedBytes = 4 * 1024 * 1024 * 1024;
const maxFiles = 20_000;
let registryRoot = process.env.NOVELTEA_TEMPLATE_REGISTRY_ROOT ?? path.join(os.homedir(), '.noveltea', 'templates', 'v1');
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const issue = (code: string, pathValue: string, message: string): TemplateCompatibilityDiagnostic => ({ code, path: pathValue, message });

export function configureTemplateRegistryRoot(root: string) { registryRoot = path.resolve(root); }
export function templateRootForToken(token: string): string {
  const match = /^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/.exec(token);
  if (!match) throw new Error('Invalid installed-template token.');
  return path.join(registryRoot, match[1]!, match[2]!);
}
async function files(root: string, prefix = ''): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link '${relative}' is forbidden.`);
    if (entry.isDirectory()) output.push(...await files(root, relative));
    else if (entry.isFile()) output.push(relative);
    else throw new Error(`Non-regular archive entry '${relative}' is forbidden.`);
  }
  return output.sort((a, b) => a.localeCompare(b));
}
function safeArchiveName(value: string) {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe archive path '${value}'.`);
  return normalized;
}
async function verifyInstalled(root: string): Promise<{ entry: TemplateRegistryEntry; descriptor: ReturnType<typeof parseTemplateDescriptor> }> {
  const entry = templateRegistryEntrySchema.parse(JSON.parse(await readFile(path.join(root, recordFile), 'utf8')));
  const descriptorData = await readFile(path.join(root, descriptorFile));
  if (digest(descriptorData) !== entry.descriptorSha256) throw new Error('Template descriptor checksum does not match its installation record.');
  const descriptor = parseTemplateDescriptor(JSON.parse(descriptorData.toString('utf8')));
  const actual = (await files(root)).filter((item) => item !== descriptorFile && item !== recordFile);
  const declared = [...descriptor.files].sort((a, b) => a.path.localeCompare(b.path));
  if (actual.length !== declared.length || actual.some((item, index) => item !== declared[index]?.path)) throw new Error('Installed template file inventory differs from the descriptor.');
  for (const item of declared) {
    const data = await readFile(path.join(root, item.path)); const info = await lstat(path.join(root, item.path));
    if (data.length !== item.size || digest(data) !== item.sha256 || (info.mode & 0o777) !== item.mode) throw new Error(`Installed template file '${item.path}' failed integrity verification.`);
  }
  return { entry, descriptor };
}
export async function inspectPlayerTemplate(templateId: string, buildId: string): Promise<InstalledTemplate | null> {
  const root = templateRootForToken(`${templateId}/${buildId}`);
  if (!existsSync(root)) return null;
  try { const value = await verifyInstalled(root); return { ...value, status: value.entry.trust === 'official' ? 'installed' : 'untrusted' }; }
  catch { try { const entry = templateRegistryEntrySchema.parse(JSON.parse(await readFile(path.join(root, recordFile), 'utf8'))); const descriptor = parseTemplateDescriptor(JSON.parse(await readFile(path.join(root, descriptorFile), 'utf8'))); return { entry, descriptor, status: 'corrupted' }; } catch { return null; } }
}
export async function listPlayerTemplates(query: TemplateRegistryQuery = {}): Promise<InstalledTemplate[]> {
  if (!existsSync(registryRoot)) return [];
  const output: InstalledTemplate[] = [];
  for (const templateId of await readdir(registryRoot)) {
    const parent = path.join(registryRoot, templateId); if (!(await lstat(parent)).isDirectory()) continue;
    for (const buildId of await readdir(parent)) { const item = await inspectPlayerTemplate(templateId, buildId); if (item && (!query.platform || item.descriptor.platform === query.platform) && (!query.architecture || item.descriptor.architecture === query.architecture) && (!query.buildFlavor || item.descriptor.buildFlavor === query.buildFlavor)) output.push(item); }
  }
  return output.sort((a, b) => `${a.descriptor.templateId}/${a.descriptor.buildId}`.localeCompare(`${b.descriptor.templateId}/${b.descriptor.buildId}`));
}
export async function installPlayerTemplate(request: TemplateInstallRequest): Promise<TemplateInstallResult> {
  const diagnostics: TemplateCompatibilityDiagnostic[] = []; let temp = '';
  try {
    const archiveInfo = await stat(request.archivePath); if (!archiveInfo.isFile() || archiveInfo.size > maxArchiveBytes) throw new Error('Template archive is missing, invalid, or exceeds the 2 GiB limit.');
    const archiveData = await readFile(request.archivePath); const archiveSha256 = digest(archiveData);
    if (request.archiveSha256 && request.archiveSha256 !== archiveSha256) throw new Error('Template archive checksum does not match the requested checksum.');
    temp = path.join(registryRoot, `.install-${process.pid}-${Date.now()}`); await rm(temp, { recursive: true, force: true }); await mkdir(temp, { recursive: true });
    const listing = (await run('cmake', ['-E', 'tar', 'tf', path.resolve(request.archivePath)], { maxBuffer: 16 * 1024 * 1024 })).stdout.split(/\r?\n/).filter((name) => !!name && name !== '.' && name !== './').map(safeArchiveName);
    if (listing.length > maxFiles) throw new Error('Template archive contains too many entries.');
    const verboseListing = (await run('cmake', ['-E', 'tar', 'tvf', path.resolve(request.archivePath)], { maxBuffer: 32 * 1024 * 1024 })).stdout;
    if (verboseListing.split(/\r?\n/).some((line) => /^[lh]/.test(line))) throw new Error('Template archive contains a symbolic or hard link.');
    const folded = new Set<string>(); for (const item of listing) { const key = item.normalize('NFC').toLocaleLowerCase('en-US'); if (folded.has(key)) throw new Error(`Template archive contains a duplicate or case-colliding path '${item}'.`); folded.add(key); }
    await run('cmake', ['-E', 'tar', 'xf', path.resolve(request.archivePath)], { cwd: temp, maxBuffer: 16 * 1024 * 1024 });
    let root = temp; let extracted = await files(root); if (!extracted.includes(descriptorFile)) { const top = [...new Set(extracted.map((item) => item.split('/')[0]))]; if (top.length !== 1 || !existsSync(path.join(temp, top[0]!, descriptorFile))) throw new Error('Template archive must contain template.json at its root.'); root = path.join(temp, top[0]!); extracted = await files(root); }
    const descriptorData = await readFile(path.join(root, descriptorFile)); const descriptorSha256 = digest(descriptorData); const descriptor = parseTemplateDescriptor(JSON.parse(descriptorData.toString('utf8')));
    const actual = extracted.filter((item) => item !== descriptorFile); const declared = [...descriptor.files].sort((a, b) => a.path.localeCompare(b.path));
    if (actual.length !== declared.length || actual.some((item, index) => item !== declared[index]?.path)) throw new Error('Archive contents do not exactly match the descriptor inventory.');
    let expanded = descriptorData.length; for (const item of declared) { const data = await readFile(path.join(root, item.path)); const info = await lstat(path.join(root, item.path)); expanded += data.length; if (expanded > maxExpandedBytes) throw new Error('Expanded template exceeds the 4 GiB limit.'); if (data.length !== item.size || digest(data) !== item.sha256 || (info.mode & 0o777) !== item.mode) throw new Error(`Archive file '${item.path}' failed descriptor verification.`); }
    const official = request.officialProvenance; const trusted = !!official && official.archiveSha256 === archiveSha256 && official.descriptorSha256 === descriptorSha256 && descriptor.provenance.provider === 'github-attestation';
    if (official && !trusted) throw new Error('Official provenance does not match the archive and descriptor.');
    const entry: TemplateRegistryEntry = { format: 'noveltea.template-registry', formatVersion: 1, templateId: descriptor.templateId, buildId: descriptor.buildId, descriptorSha256, archiveSha256, installedAt: new Date().toISOString(), origin: official?.source ?? request.origin ?? path.basename(request.archivePath), trust: trusted ? 'official' : 'local-untrusted', verified: true };
    await writeFile(path.join(root, recordFile), `${JSON.stringify(entry, null, 2)}\n`);
    const destination = templateRootForToken(`${descriptor.templateId}/${descriptor.buildId}`); const backup = `${destination}.previous`; await mkdir(path.dirname(destination), { recursive: true }); await rm(backup, { recursive: true, force: true });
    const hadPrevious = existsSync(destination); if (hadPrevious) await rename(destination, backup);
    try { await rename(root, destination); await rm(backup, { recursive: true, force: true }); }
    catch (error) { if (hadPrevious && !existsSync(destination) && existsSync(backup)) await rename(backup, destination); throw error; }
    if (root !== temp) await rm(temp, { recursive: true, force: true });
    return { success: true, entry, diagnostics };
  } catch (error) { diagnostics.push(issue('template-install-failed', '/archive', error instanceof Error ? error.message : String(error))); if (temp) await rm(temp, { recursive: true, force: true }); return { success: false, diagnostics }; }
}
export async function removePlayerTemplate(templateId: string, buildId: string): Promise<{ removed: boolean }> { const root = templateRootForToken(`${templateId}/${buildId}`); const removed = existsSync(root); await rm(root, { recursive: true, force: true }); return { removed }; }
export async function resolvePlayerTemplate(request: TemplateResolveRequest): Promise<TemplateResolveResult> {
  const requirements = templateCompatibilityRequirementsSchema.parse(request.requirements); const candidates = await listPlayerTemplates({ platform: requirements.profile.target, architecture: requirements.profile.architecture, buildFlavor: requirements.profile.buildFlavor }); const diagnostics: TemplateCompatibilityDiagnostic[] = [];
  for (const template of candidates) { if (template.status === 'corrupted') { diagnostics.push(issue('template-corrupted', '/template', `${template.descriptor.templateId}/${template.descriptor.buildId} is corrupted.`)); continue; } const compatibility = evaluateTemplateCompatibility(template.descriptor, requirements); if (compatibility.compatible) return { success: true, token: `${template.descriptor.templateId}/${template.descriptor.buildId}`, template: { ...template, compatibility }, diagnostics: template.status === 'untrusted' ? [issue('template-untrusted', '/template', 'Template is locally installed and has no official provenance.')] : [] }; diagnostics.push(...compatibility.diagnostics); }
  if (!candidates.length) diagnostics.push(issue('template-missing', '/template', 'No installed template matches the selected target, architecture, and build flavor.'));
  return { success: false, diagnostics };
}
export async function verifyTemplateToken(token: string) { return verifyInstalled(templateRootForToken(token)); }
