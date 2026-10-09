import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  parseTemplateDescriptor,
  templateCompatibilityRequirementsSchema,
  templateRegistryEntrySchema,
  type InstalledTemplate,
  type TemplateCompatibilityDiagnostic,
  type TemplateDescriptor,
  type TemplateInstallRequest,
  type TemplateInstallResult,
  type TemplateRegistryEntry,
  type TemplateRegistryQuery,
  type TemplateResolveRequest,
  type TemplateResolveResult,
} from '../../shared/project-schema/platform-export-contracts';
import { evaluateTemplateCompatibility } from '../../shared/project-schema/template-compatibility';
import { runPlatformProcess } from './platform-host-service';

const run = runPlatformProcess;
const descriptorFile = 'template.json';
const recordFile = '.noveltea-template.json';
const maxArchiveBytes = 2 * 1024 * 1024 * 1024;
const maxExpandedBytes = 4 * 1024 * 1024 * 1024;
const maxFiles = 20_000;
const archiveTool = () =>
  process.env.NOVELTEA_TAR ?? (process.platform === 'win32' ? 'tar.exe' : 'tar');
const unzipTool = () => process.env.NOVELTEA_UNZIP ?? 'unzip';
const zipInfoTool = () => process.env.NOVELTEA_ZIPINFO ?? 'zipinfo';
let configuredRegistryRoot: string | null = null;
const registryRoot = () =>
  configuredRegistryRoot ??
  process.env.NOVELTEA_TEMPLATE_REGISTRY_ROOT ??
  path.join(os.homedir(), '.noveltea', 'templates');
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const licenseSlug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13))
      return true;
  }
  return false;
}
const engineNoticeIndexSchema = z
  .object({
    format: z.literal('noveltea.engine-licenses'),
    components: z
      .array(
        z
          .object({
            component: z.string().trim().min(1),
            displayName: z.string().trim().min(1),
            version: z.string().trim().min(1),
            files: z
              .array(
                z
                  .object({
                    path: z.string().regex(/^licenses\/[a-z0-9-]+--[a-z0-9-]+\.txt$/),
                    size: z.number().int().positive(),
                    sha256: z.string().regex(/^[0-9a-f]{64}$/),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

async function verifyEngineLicenses(root: string, descriptor: TemplateDescriptor) {
  if (descriptor.platform === 'android') return; // Android's independent template work is not #413.
  const index = engineNoticeIndexSchema.parse(
    JSON.parse(await readFile(path.join(root, 'licenses/index.json'), 'utf8')),
  );
  const declared = new Map(descriptor.files.map((item) => [item.path, item]));
  const indexed = new Set(['licenses/index.json']);
  const named = new Set<string>();
  let previous = '';
  for (const component of index.components) {
    if (named.has(component.component) || (previous && previous >= component.component))
      throw new Error(
        `Engine license index has duplicate or unordered component '${component.component}'.`,
      );
    named.add(component.component);
    previous = component.component;
    for (const file of component.files) {
      if (!file.path.startsWith(`licenses/${licenseSlug(component.component)}--`))
        throw new Error(`License '${file.path}' does not belong to '${component.component}'.`);
      if (indexed.has(file.path)) throw new Error(`Duplicate license index path '${file.path}'.`);
      indexed.add(file.path);
      const item = declared.get(file.path);
      if (
        !item ||
        item.size !== file.size ||
        item.sha256 !== file.sha256 ||
        (item.role && item.role !== 'notice')
      )
        throw new Error(
          `License index entry '${file.path}' disagrees with the template inventory.`,
        );
      const bytes = await readFile(path.join(root, file.path));
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (
        bytes.length !== file.size ||
        digest(bytes) !== file.sha256 ||
        !content.trim() ||
        containsControlCharacters(content) ||
        /No dependency notice file was found|Resolved dependency license texts are collected|PLACEHOLDER LICENSE/i.test(
          content,
        )
      )
        throw new Error(`Invalid or placeholder engine license text '${file.path}'.`);
    }
  }
  const licensePaths = [...declared.keys()].filter((name) => name.startsWith('licenses/')).sort();
  const noticeDependencies = descriptor.runtimeDependencies
    .filter((item) => item.kind === 'notice')
    .map((item) => item.path)
    .sort();
  if (
    !declared.has('licenses/index.json') ||
    licensePaths.join('\n') !== [...indexed].sort().join('\n') ||
    noticeDependencies.join('\n') !== licensePaths.join('\n')
  )
    throw new Error('Template license files/index and runtime dependencies are inconsistent.');
  const sbom = JSON.parse(await readFile(path.join(root, descriptor.artifacts.sbom), 'utf8')) as {
    bomFormat?: string;
    components?: Array<{ name: string; version: string }>;
  };
  const sbomNames = (sbom.components ?? [])
    .map((item) => `${item.name}\u0000${item.version}`)
    .sort();
  const noticeNames = index.components
    .map((item) => `${item.component}\u0000${item.version}`)
    .sort();
  if (sbom.bomFormat !== 'CycloneDX' || sbomNames.join('\n') !== noticeNames.join('\n'))
    throw new Error('Template SBOM and engine license index component coverage disagree.');
}
const issue = (
  code: string,
  pathValue: string,
  message: string,
): TemplateCompatibilityDiagnostic => ({ code, path: pathValue, message });

export function configureTemplateRegistryRoot(root: string) {
  configuredRegistryRoot = path.resolve(root);
}
export function templateRootForToken(token: string): string {
  const match = /^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/.exec(token);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') {
    throw new Error('Invalid installed-template token.');
  }
  const root = path.resolve(registryRoot());
  const candidate = path.resolve(root, match[1], match[2]);
  const relative = path.relative(root, candidate);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Installed-template token escapes the registry root.');
  }
  return candidate;
}
async function files(root: string, prefix = ''): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link '${relative}' is forbidden.`);
    if (entry.isDirectory()) output.push(...(await files(root, relative)));
    else if (entry.isFile()) output.push(relative);
    else throw new Error(`Non-regular archive entry '${relative}' is forbidden.`);
  }
  return output.sort((a, b) => a.localeCompare(b));
}
function safeArchiveName(value: string) {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Unsafe archive path '${value}'.`);
  return normalized;
}

function isZipArchive(archivePath: string): boolean {
  return path.extname(archivePath).toLocaleLowerCase('en-US') === '.zip';
}

async function listArchive(archivePath: string): Promise<{
  listing: string[];
  containsLinks: boolean;
}> {
  const resolved = path.resolve(archivePath);
  if (isZipArchive(resolved) && process.platform !== 'win32') {
    const listing = (
      await run(unzipTool(), ['-Z1', resolved], { maxBuffer: 16 * 1024 * 1024 })
    ).stdout
      .split(/\r?\n/)
      .filter((name) => !!name && name !== '.' && name !== './')
      .map(safeArchiveName);
    const verbose = (await run(zipInfoTool(), ['-l', resolved], { maxBuffer: 32 * 1024 * 1024 }))
      .stdout;
    return {
      listing,
      containsLinks: verbose.split(/\r?\n/).some((line) => line.trimStart().startsWith('l')),
    };
  }
  const listing = (
    await run(archiveTool(), ['-tf', resolved], { maxBuffer: 16 * 1024 * 1024 })
  ).stdout
    .split(/\r?\n/)
    .filter((name) => !!name && name !== '.' && name !== './')
    .map(safeArchiveName);
  const verbose = (await run(archiveTool(), ['-tvf', resolved], { maxBuffer: 32 * 1024 * 1024 }))
    .stdout;
  return {
    listing,
    containsLinks: verbose.split(/\r?\n/).some((line) => /^[lh]/.test(line.trimStart())),
  };
}

async function extractArchive(archivePath: string, destination: string): Promise<void> {
  const resolved = path.resolve(archivePath);
  if (isZipArchive(resolved) && process.platform !== 'win32') {
    await run(unzipTool(), ['-qq', resolved, '-d', destination], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return;
  }
  await run(archiveTool(), ['-xf', resolved], {
    cwd: destination,
    maxBuffer: 16 * 1024 * 1024,
  });
}
async function verifyInstalled(root: string): Promise<{
  entry: TemplateRegistryEntry;
  descriptor: ReturnType<typeof parseTemplateDescriptor>;
}> {
  const entry = templateRegistryEntrySchema.parse(
    JSON.parse(await readFile(path.join(root, recordFile), 'utf8')),
  );
  const descriptorData = await readFile(path.join(root, descriptorFile));
  if (digest(descriptorData) !== entry.descriptorSha256)
    throw new Error('Template descriptor checksum does not match its installation record.');
  const descriptor = parseTemplateDescriptor(JSON.parse(descriptorData.toString('utf8')));
  const actual = (await files(root)).filter(
    (item) => item !== descriptorFile && item !== recordFile,
  );
  const declared = [...descriptor.files].sort((a, b) => a.path.localeCompare(b.path));
  if (
    actual.length !== declared.length ||
    actual.some((item, index) => item !== declared[index]?.path)
  )
    throw new Error('Installed template file inventory differs from the descriptor.');
  for (const item of declared) {
    const data = await readFile(path.join(root, item.path));
    if (data.length !== item.size || digest(data) !== item.sha256)
      throw new Error(`Installed template file '${item.path}' failed integrity verification.`);
  }
  await verifyEngineLicenses(root, descriptor);
  return { entry, descriptor };
}
export async function inspectPlayerTemplate(
  templateId: string,
  buildId: string,
): Promise<InstalledTemplate | null> {
  const root = templateRootForToken(`${templateId}/${buildId}`);
  if (!existsSync(root)) return null;
  try {
    const value = await verifyInstalled(root);
    return { ...value, status: value.entry.trust === 'official' ? 'installed' : 'untrusted' };
  } catch {
    try {
      const entry = templateRegistryEntrySchema.parse(
        JSON.parse(await readFile(path.join(root, recordFile), 'utf8')),
      );
      const descriptor = parseTemplateDescriptor(
        JSON.parse(await readFile(path.join(root, descriptorFile), 'utf8')),
      );
      return { entry, descriptor, status: 'corrupted' };
    } catch {
      return null;
    }
  }
}
export async function listPlayerTemplates(
  query: TemplateRegistryQuery = {},
): Promise<InstalledTemplate[]> {
  const root = registryRoot();
  if (!existsSync(root)) return [];
  const output: InstalledTemplate[] = [];
  for (const templateId of await readdir(root)) {
    const parent = path.join(root, templateId);
    if (!(await lstat(parent)).isDirectory()) continue;
    for (const buildId of await readdir(parent)) {
      const item = await inspectPlayerTemplate(templateId, buildId);
      if (
        item &&
        (!query.platform || item.descriptor.platform === query.platform) &&
        (!query.architecture || item.descriptor.architecture === query.architecture) &&
        (!query.buildFlavor || item.descriptor.buildFlavor === query.buildFlavor)
      )
        output.push(item);
    }
  }
  return output.sort((a, b) =>
    `${a.descriptor.templateId}/${a.descriptor.buildId}`.localeCompare(
      `${b.descriptor.templateId}/${b.descriptor.buildId}`,
    ),
  );
}
export async function installPlayerTemplate(
  request: TemplateInstallRequest,
): Promise<TemplateInstallResult> {
  const diagnostics: TemplateCompatibilityDiagnostic[] = [];
  let temp = '';
  try {
    const archiveInfo = await stat(request.archivePath);
    if (!archiveInfo.isFile() || archiveInfo.size > maxArchiveBytes)
      throw new Error('Template archive is missing, invalid, or exceeds the 2 GiB limit.');
    const archiveData = await readFile(request.archivePath);
    const archiveSha256 = digest(archiveData);
    if (request.archiveSha256 && request.archiveSha256 !== archiveSha256)
      throw new Error('Template archive checksum does not match the requested checksum.');
    temp = path.join(registryRoot(), `.install-${process.pid}-${Date.now()}`);
    await rm(temp, { recursive: true, force: true });
    await mkdir(temp, { recursive: true });
    const archive = await listArchive(request.archivePath);
    const listing = archive.listing;
    if (listing.length > maxFiles) throw new Error('Template archive contains too many entries.');
    if (archive.containsLinks)
      throw new Error('Template archive contains a symbolic or hard link.');
    const folded = new Set<string>();
    for (const item of listing) {
      const key = item.normalize('NFC').toLocaleLowerCase('en-US');
      if (folded.has(key))
        throw new Error(`Template archive contains a duplicate or case-colliding path '${item}'.`);
      folded.add(key);
    }
    await extractArchive(request.archivePath, temp);
    let root = temp;
    let extracted = await files(root);
    if (!extracted.includes(descriptorFile)) {
      const top = [...new Set(extracted.map((item) => item.split('/')[0]))];
      if (top.length !== 1 || !existsSync(path.join(temp, top[0]!, descriptorFile)))
        throw new Error('Template archive must contain template.json at its root.');
      root = path.join(temp, top[0]!);
      extracted = await files(root);
    }
    const descriptorData = await readFile(path.join(root, descriptorFile));
    const descriptorSha256 = digest(descriptorData);
    const descriptor = parseTemplateDescriptor(JSON.parse(descriptorData.toString('utf8')));
    const actual = extracted.filter((item) => item !== descriptorFile);
    const declared = [...descriptor.files].sort((a, b) => a.path.localeCompare(b.path));
    if (
      actual.length !== declared.length ||
      actual.some((item, index) => item !== declared[index]?.path)
    )
      throw new Error('Archive contents do not exactly match the descriptor inventory.');
    let expanded = descriptorData.length;
    for (const item of declared) {
      const data = await readFile(path.join(root, item.path));
      expanded += data.length;
      if (expanded > maxExpandedBytes)
        throw new Error('Expanded template exceeds the 4 GiB limit.');
      if (data.length !== item.size || digest(data) !== item.sha256)
        throw new Error(`Archive file '${item.path}' failed descriptor verification.`);
    }
    await verifyEngineLicenses(root, descriptor);
    const official = request.officialProvenance;
    const trusted =
      !!official &&
      official.archiveSha256 === archiveSha256 &&
      official.descriptorSha256 === descriptorSha256 &&
      descriptor.provenance.provider === 'github-attestation';
    if (official && !trusted)
      throw new Error('Official provenance does not match the archive and descriptor.');
    const entry: TemplateRegistryEntry = {
      format: 'noveltea.template-registry',
      templateId: descriptor.templateId,
      buildId: descriptor.buildId,
      descriptorSha256,
      archiveSha256,
      installedAt: new Date().toISOString(),
      origin: official?.source ?? request.origin ?? path.basename(request.archivePath),
      trust: trusted ? 'official' : 'local-untrusted',
      verified: true,
    };
    await writeFile(path.join(root, recordFile), `${JSON.stringify(entry, null, 2)}\n`);
    const destination = templateRootForToken(`${descriptor.templateId}/${descriptor.buildId}`);
    if (existsSync(destination) && !request.force)
      throw new Error(
        `Template '${descriptor.templateId}@${descriptor.buildId}' is already installed; use --force to replace it.`,
      );
    const backup = `${destination}.previous`;
    await mkdir(path.dirname(destination), { recursive: true });
    await rm(backup, { recursive: true, force: true });
    const hadPrevious = existsSync(destination);
    if (hadPrevious) await rename(destination, backup);
    try {
      await rename(root, destination);
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      if (hadPrevious && !existsSync(destination) && existsSync(backup))
        await rename(backup, destination);
      throw error;
    }
    if (root !== temp) await rm(temp, { recursive: true, force: true });
    return { success: true, entry, diagnostics };
  } catch (error) {
    diagnostics.push(
      issue(
        'template-install-failed',
        '/archive',
        error instanceof Error ? error.message : String(error),
      ),
    );
    if (temp) await rm(temp, { recursive: true, force: true });
    return { success: false, diagnostics };
  }
}
export async function removePlayerTemplate(
  templateId: string,
  buildId: string,
): Promise<{ removed: boolean }> {
  const root = templateRootForToken(`${templateId}/${buildId}`);
  const removed = existsSync(root);
  await rm(root, { recursive: true, force: true });
  return { removed };
}
export async function resolvePlayerTemplate(
  request: TemplateResolveRequest,
): Promise<TemplateResolveResult> {
  const requirements = templateCompatibilityRequirementsSchema.parse(request.requirements);
  const candidates = await listPlayerTemplates({
    platform: requirements.profile.target,
    architecture: requirements.profile.architecture,
    buildFlavor: requirements.profile.buildFlavor,
  });
  const diagnostics: TemplateCompatibilityDiagnostic[] = [];
  const compatible: InstalledTemplate[] = [];
  for (const template of candidates) {
    if (template.status === 'corrupted') {
      diagnostics.push(
        issue(
          'template-corrupted',
          '/template',
          `${template.descriptor.templateId}/${template.descriptor.buildId} is corrupted.`,
        ),
      );
      continue;
    }
    const compatibility = evaluateTemplateCompatibility(template.descriptor, requirements);
    if (compatibility.compatible) {
      compatible.push({ ...template, compatibility });
      continue;
    }
    diagnostics.push(...compatibility.diagnostics);
  }
  if (!candidates.length)
    diagnostics.push(
      issue(
        'template-missing',
        '/template',
        'No installed template matches the selected target, architecture, and build flavor.',
      ),
    );
  if (compatible.length === 1) {
    const template = compatible[0]!;
    return {
      success: true,
      token: `${template.descriptor.templateId}/${template.descriptor.buildId}`,
      template,
      diagnostics:
        template.status === 'untrusted'
          ? [
              issue(
                'template-untrusted',
                '/template',
                'Template is locally installed and has no official provenance.',
              ),
            ]
          : [],
    };
  }
  if (compatible.length > 1) {
    const tokens = compatible
      .map((template) => `${template.descriptor.templateId}@${template.descriptor.buildId}`)
      .sort();
    diagnostics.push(
      issue(
        'template-ambiguous',
        '/template',
        `Multiple compatible templates are installed; select one with --template: ${tokens.join(', ')}.`,
      ),
    );
  }
  return { success: false, diagnostics };
}
export async function verifyTemplateToken(token: string) {
  return verifyInstalled(templateRootForToken(token));
}
