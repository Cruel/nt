import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import {
  parseComfyUiWorkflowDefinition,
  resolveComfyUiWorkflowBinding,
  resolvedComfyUiWorkflowOutputNodeIdList,
  validateComfyUiWorkflowDefinitionContract,
  type ComfyUiPackageHash,
  type ComfyUiWorkflowCopyRequest,
  type ComfyUiWorkflowCopyResponse,
  type ComfyUiWorkflowDeleteRequest,
  type ComfyUiWorkflowDeleteResponse,
  type ComfyUiWorkflowDiagnostic,
  type ComfyUiWorkflowGraphLike,
  type ComfyUiWorkflowKey,
  type ComfyUiWorkflowLibraryEntry,
  type ComfyUiWorkflowLibraryListRequest,
  type ComfyUiWorkflowLibraryListResponse,
  type ComfyUiWorkflowRootSummary,
  type ComfyUiWorkflowSource,
  type ComfyUiWorkflowValidationStatus,
  type ComfyUiWorkflowVerificationRecord,
} from '../../shared/comfyui-workflows';

interface WorkflowLibraryRoots {
  builtInRoot: string | null;
  editorRoot: string;
  projectRoot: string | null;
  cacheFile: string;
}

export interface WorkflowLibraryServiceOptions {
  roots?: Partial<WorkflowLibraryRoots>;
  showItemInFolder?: (itemPath: string) => Promise<void> | void;
}

type WorkflowSourceRoot = {
  source: ComfyUiWorkflowSource;
  root: string;
  writable: boolean;
  available: boolean;
};

function diagnostic(pathValue: string, message: string, severity: ComfyUiWorkflowDiagnostic['severity'] = 'error'): ComfyUiWorkflowDiagnostic {
  return { severity, category: 'comfyui-workflows', path: pathValue, message };
}

function entryStatus(diagnostics: ComfyUiWorkflowDiagnostic[]): ComfyUiWorkflowValidationStatus {
  if (diagnostics.some((item) => item.severity === 'error')) return 'invalid';
  if (diagnostics.some((item) => item.severity === 'warning' || item.severity === 'info')) return 'warning';
  return 'valid';
}

function sourceRank(source: ComfyUiWorkflowSource) {
  if (source === 'project') return 3;
  if (source === 'editor') return 2;
  return 1;
}

function workflowKey(source: ComfyUiWorkflowSource, manifestFile: string): ComfyUiWorkflowKey {
  return `${source}:${manifestFile}`;
}

function sourceFromWorkflowKey(key: ComfyUiWorkflowKey): ComfyUiWorkflowSource {
  return key.slice(0, key.indexOf(':')) as ComfyUiWorkflowSource;
}

function manifestFileFromWorkflowKey(key: ComfyUiWorkflowKey): string {
  return key.slice(key.indexOf(':') + 1);
}

function projectRootFromFile(projectFilePath: string | null | undefined) {
  return projectFilePath ? path.dirname(path.resolve(projectFilePath)) : null;
}

function resolveEditorAssetsRoot(): string | null {
  if (app.isPackaged) {
    const packagedRoot = path.join(process.resourcesPath, 'editor-assets');
    return existsSync(packagedRoot) && statSync(packagedRoot).isDirectory() ? packagedRoot : null;
  }

  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, 'assets'),
    path.resolve(cwd, 'editor', 'assets'),
    path.resolve(app.getAppPath(), 'assets'),
    path.resolve(app.getAppPath(), 'editor', 'assets'),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isDirectory()) ?? null;
}

export function resolveComfyUiWorkflowLibraryRoots(projectFilePath?: string | null, options: WorkflowLibraryServiceOptions = {}): WorkflowLibraryRoots {
  const needsUserData = !options.roots?.editorRoot || !options.roots?.cacheFile;
  const userData = needsUserData ? app.getPath('userData') : '';
  const editorRoot = options.roots?.editorRoot ?? path.join(userData, 'workflows');
  const projectRoot = options.roots?.projectRoot ?? (projectRootFromFile(projectFilePath) ? path.join(projectRootFromFile(projectFilePath)!, 'workflows') : null);
  const assetRoot = options.roots?.builtInRoot === undefined ? resolveEditorAssetsRoot() : null;
  return {
    builtInRoot: options.roots?.builtInRoot ?? (assetRoot ? path.join(assetRoot, 'comfyui', 'workflows') : null),
    editorRoot,
    projectRoot,
    cacheFile: options.roots?.cacheFile ?? path.join(editorRoot, '.verification-cache.json'),
  };
}

function sourceRoots(projectFilePath?: string | null, options: WorkflowLibraryServiceOptions = {}): WorkflowSourceRoot[] {
  const roots = resolveComfyUiWorkflowLibraryRoots(projectFilePath, options);
  return [
    { source: 'built-in', root: roots.builtInRoot ?? '', writable: false, available: Boolean(roots.builtInRoot) },
    { source: 'editor', root: roots.editorRoot, writable: true, available: true },
    { source: 'project', root: roots.projectRoot ?? '', writable: true, available: Boolean(roots.projectRoot) },
  ];
}

async function readManifestFiles(root: WorkflowSourceRoot): Promise<string[]> {
  if (!root.available || !root.root) return [];
  try {
    const entries = await fs.readdir(root.root);
    return entries.filter((entry) => entry.endsWith('.manifest.json')).sort();
  } catch {
    return [];
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeComfyUiWorkflowPackageHash(manifest: unknown, workflow: unknown): ComfyUiPackageHash {
  return `sha256:${createHash('sha256').update(canonicalJson(manifest)).update('\n').update(canonicalJson(workflow)).digest('hex')}`;
}

function validateWorkflowBindings(workflow: ComfyUiWorkflowGraphLike, entry: Pick<ComfyUiWorkflowLibraryEntry, 'definition' | 'manifestFile'>): ComfyUiWorkflowDiagnostic[] {
  if (!entry.definition) return [];
  const definition = entry.definition;
  const diagnostics: ComfyUiWorkflowDiagnostic[] = [...validateComfyUiWorkflowDefinitionContract(definition)];
  for (const [semanticKey, binding] of Object.entries(definition.bindings)) {
    if (!binding) continue;
    const resolution = resolveComfyUiWorkflowBinding(workflow, binding);
    if (!resolution.ok) diagnostics.push(diagnostic(`/workflows/${entry.manifestFile}/bindings/${semanticKey}`, resolution.message ?? `Workflow '${definition.label}' has an unresolved binding.`));
    if (resolution.ok && resolution.rebased && binding.nodeId && resolution.nodeId) {
      diagnostics.push(diagnostic(`/workflows/${entry.manifestFile}/bindings/${semanticKey}`, `Rebased stale node id ${binding.nodeId} to node ${resolution.nodeId} using selector metadata.`, 'info'));
    }
  }
  try {
    resolvedComfyUiWorkflowOutputNodeIdList(workflow, definition);
  } catch (error) {
    diagnostics.push(diagnostic(`/workflows/${entry.manifestFile}/outputBindings/images`, error instanceof Error ? error.message : 'Workflow output bindings could not be resolved.'));
  }
  if (!definition.outputBindings.images?.length) diagnostics.push(diagnostic(`/workflows/${entry.manifestFile}/outputBindings/images`, `Workflow '${definition.label}' uses legacy outputNodeIds; repair or reimport it to add explicit output bindings.`, 'warning'));
  return diagnostics;
}

function capabilities(source: ComfyUiWorkflowSource, status: ComfyUiWorkflowValidationStatus, hasWorkflowText: boolean, hasProject: boolean) {
  const mutable = source !== 'built-in';
  return {
    canCopyToEditor: status !== 'invalid' && source !== 'editor',
    canCopyToProject: status !== 'invalid' && hasProject && source !== 'project',
    canDelete: mutable,
    canRepair: mutable && hasWorkflowText,
    canReveal: mutable,
  };
}

async function discoverSource(root: WorkflowSourceRoot, hasProject: boolean): Promise<ComfyUiWorkflowLibraryEntry[]> {
  const entries: ComfyUiWorkflowLibraryEntry[] = [];
  for (const manifestFile of await readManifestFiles(root)) {
    const manifestPath = path.join(root.root, manifestFile);
    let manifestJsonText: string | undefined;
    let workflowJsonText: string | undefined;
    try {
      manifestJsonText = await fs.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestJsonText);
      const definition = parseComfyUiWorkflowDefinition(manifest, manifestFile);
      const workflowPath = path.join(root.root, definition.workflowFile);
      const relative = path.relative(root.root, workflowPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Workflow file escapes the workflows directory.');
      workflowJsonText = await fs.readFile(workflowPath, 'utf8');
      const workflow = JSON.parse(workflowJsonText);
      const diagnostics = validateWorkflowBindings(workflow as ComfyUiWorkflowGraphLike, { definition, manifestFile });
      const offlineStatus = entryStatus(diagnostics);
      entries.push({
        source: root.source,
        workflowKey: workflowKey(root.source, manifestFile),
        id: definition.id,
        label: definition.label,
        role: definition.role,
        definition,
        manifestFile,
        workflowFile: definition.workflowFile,
        manifestPath,
        workflowPath,
        packageHash: computeComfyUiWorkflowPackageHash(manifest, workflow),
        active: false,
        overridden: false,
        offlineStatus,
        onlineStatus: 'unverified',
        repairable: Boolean(workflowJsonText) && root.writable,
        diagnostics,
        verificationDiagnostics: [],
        manifestJsonText,
        workflowJsonText,
        capabilities: capabilities(root.source, offlineStatus, Boolean(workflowJsonText), hasProject),
      });
    } catch (error) {
      const diagnostics = [diagnostic(`/workflows/${manifestFile}`, error instanceof Error ? error.message : 'Workflow package is invalid.')];
      entries.push({
        source: root.source,
        workflowKey: workflowKey(root.source, manifestFile),
        manifestFile,
        manifestPath,
        active: false,
        overridden: false,
        offlineStatus: 'invalid',
        onlineStatus: 'unverified',
        repairable: false,
        diagnostics,
        verificationDiagnostics: [],
        manifestJsonText,
        workflowJsonText,
        capabilities: capabilities(root.source, 'invalid', Boolean(workflowJsonText), hasProject),
      });
    }
  }
  return entries;
}

function applyOverrides(entries: ComfyUiWorkflowLibraryEntry[]) {
  const validById = new Map<string, ComfyUiWorkflowLibraryEntry[]>();
  for (const entry of entries) {
    if (!entry.id || entry.offlineStatus === 'invalid') continue;
    validById.set(entry.id, [...(validById.get(entry.id) ?? []), entry]);
  }
  for (const sameIdEntries of validById.values()) {
    sameIdEntries.sort((left, right) => sourceRank(right.source) - sourceRank(left.source));
    const active = sameIdEntries[0]!;
    active.active = true;
    for (const entry of sameIdEntries.slice(1)) {
      entry.active = false;
      entry.overridden = true;
      entry.overriddenBy = active.workflowKey;
    }
  }
}

async function readVerificationCache(cacheFile: string): Promise<ComfyUiWorkflowVerificationRecord[]> {
  try {
    const value = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as unknown;
    return Array.isArray(value) ? value as ComfyUiWorkflowVerificationRecord[] : [];
  } catch {
    return [];
  }
}

export async function writeComfyUiWorkflowVerificationCache(records: ComfyUiWorkflowVerificationRecord[], projectFilePath?: string | null, options: WorkflowLibraryServiceOptions = {}) {
  const { cacheFile } = resolveComfyUiWorkflowLibraryRoots(projectFilePath, options);
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

function applyVerificationCache(entries: ComfyUiWorkflowLibraryEntry[], records: ComfyUiWorkflowVerificationRecord[]) {
  const byHash = new Map(records.map((record) => [`${record.workflowKey}:${record.packageHash}`, record]));
  for (const entry of entries) {
    if (!entry.packageHash) continue;
    const record = byHash.get(`${entry.workflowKey}:${entry.packageHash}`);
    if (!record) continue;
    entry.onlineStatus = record.status === 'verified' ? 'previously-verified' : 'failed';
    entry.verificationDiagnostics = record.diagnostics;
  }
}

function sourceSummary(root: WorkflowSourceRoot, entries: ComfyUiWorkflowLibraryEntry[]): ComfyUiWorkflowRootSummary {
  const rootEntries = entries.filter((entry) => entry.source === root.source);
  return {
    source: root.source,
    root: root.root,
    writable: root.writable,
    available: root.available,
    workflowCount: rootEntries.length,
    activeCount: rootEntries.filter((entry) => entry.active).length,
    overriddenCount: rootEntries.filter((entry) => entry.overridden).length,
    diagnostics: root.available ? [] : [diagnostic(`/workflows/${root.source}`, `${root.source} workflow root is unavailable.`, 'warning')],
  };
}

export async function listComfyUiWorkflowLibrary(request: ComfyUiWorkflowLibraryListRequest = {}, options: WorkflowLibraryServiceOptions = {}): Promise<ComfyUiWorkflowLibraryListResponse> {
  const roots = sourceRoots(request.projectFilePath, options);
  const hasProject = roots.some((root) => root.source === 'project' && root.available);
  const entries = (await Promise.all(roots.map((root) => discoverSource(root, hasProject)))).flat();
  applyOverrides(entries);
  applyVerificationCache(entries, await readVerificationCache(resolveComfyUiWorkflowLibraryRoots(request.projectFilePath, options).cacheFile));
  const visibleEntries = request.includeOverridden ? entries : entries.filter((entry) => !entry.overridden);
  const diagnostics = [...entries.flatMap((entry) => entry.diagnostics), ...roots.flatMap((root) => sourceSummary(root, entries).diagnostics)];
  return {
    ok: !diagnostics.some((item) => item.severity === 'error'),
    success: true,
    entries: visibleEntries,
    activeWorkflows: entries
      .filter((entry) => entry.active && entry.definition && entry.id && entry.label && entry.role && entry.offlineStatus !== 'invalid')
      .map((entry) => ({
        workflowKey: entry.workflowKey,
        source: entry.source,
        id: entry.id!,
        label: entry.label!,
        role: entry.role!,
        definition: entry.definition!,
        packageHash: entry.packageHash,
        offlineStatus: entry.offlineStatus as 'valid' | 'warning',
        onlineStatus: entry.onlineStatus,
        diagnostics: entry.diagnostics,
        verificationDiagnostics: entry.verificationDiagnostics,
      })),
    overriddenEntries: entries.filter((entry) => entry.overridden),
    summary: {
      sources: roots.map((root) => sourceSummary(root, entries)),
      totalCount: entries.length,
      activeCount: entries.filter((entry) => entry.active).length,
      overriddenCount: entries.filter((entry) => entry.overridden).length,
      invalidCount: entries.filter((entry) => entry.offlineStatus === 'invalid').length,
      verifiedCount: entries.filter((entry) => entry.onlineStatus === 'verified' || entry.onlineStatus === 'previously-verified').length,
      failedVerificationCount: entries.filter((entry) => entry.onlineStatus === 'failed').length,
    },
    diagnostics,
    error: diagnostics.find((item) => item.severity === 'error')?.message,
  };
}

function rootForSource(source: ComfyUiWorkflowSource, roots: WorkflowLibraryRoots): string | null {
  if (source === 'built-in') return roots.builtInRoot;
  if (source === 'editor') return roots.editorRoot;
  return roots.projectRoot;
}

async function copyFileReplace(source: string, destination: string) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

export async function copyComfyUiWorkflow(request: ComfyUiWorkflowCopyRequest, options: WorkflowLibraryServiceOptions = {}): Promise<ComfyUiWorkflowCopyResponse> {
  const library = await listComfyUiWorkflowLibrary({ projectFilePath: request.projectFilePath, includeOverridden: true }, options);
  const sourceEntry = library.entries.find((entry) => entry.workflowKey === request.workflowKey);
  if (!sourceEntry?.definition || !sourceEntry.workflowPath || !sourceEntry.packageHash) return { ok: false, success: false, action: 'rejected', diagnostics: [diagnostic('/workflowKey', 'Workflow is missing or invalid.')], error: 'Workflow is missing or invalid.' };
  const roots = resolveComfyUiWorkflowLibraryRoots(request.projectFilePath, options);
  const targetRoot = rootForSource(request.targetSource, roots);
  if (!targetRoot) return { ok: false, success: false, action: 'rejected', diagnostics: [diagnostic('/targetSource', 'Target workflow root is unavailable.')], error: 'Target workflow root is unavailable.' };
  const targetExisting = library.entries.find((entry) => entry.source === request.targetSource && entry.id === sourceEntry.id);
  if (targetExisting?.packageHash === sourceEntry.packageHash) return { ok: true, success: true, action: 'already-copied', sourceWorkflowKey: sourceEntry.workflowKey, targetWorkflowKey: targetExisting.workflowKey, entry: targetExisting, diagnostics: [] };
  if (targetExisting && !request.replace) return { ok: false, success: false, action: 'replace-required', sourceWorkflowKey: sourceEntry.workflowKey, targetWorkflowKey: targetExisting.workflowKey, entry: targetExisting, diagnostics: [diagnostic('/replace', `Workflow '${sourceEntry.id}' already exists in ${request.targetSource}.`, 'warning')], error: 'Replace confirmation is required.' };
  const targetManifestFile = targetExisting?.manifestFile ?? sourceEntry.manifestFile;
  await copyFileReplace(sourceEntry.manifestPath, path.join(targetRoot, targetManifestFile));
  await copyFileReplace(sourceEntry.workflowPath, path.join(targetRoot, sourceEntry.definition.workflowFile));
  if (targetExisting?.workflowFile && targetExisting.workflowFile !== sourceEntry.definition.workflowFile) {
    await fs.rm(path.join(targetRoot, targetExisting.workflowFile), { force: true });
  }
  const refreshed = await listComfyUiWorkflowLibrary({ projectFilePath: request.projectFilePath, includeOverridden: true }, options);
  const targetEntry = refreshed.entries.find((entry) => entry.source === request.targetSource && entry.id === sourceEntry.id);
  return { ok: true, success: true, action: targetExisting ? 'replaced' : 'copied', sourceWorkflowKey: sourceEntry.workflowKey, targetWorkflowKey: targetEntry?.workflowKey, entry: targetEntry, diagnostics: [] };
}

export async function deleteComfyUiWorkflow(request: ComfyUiWorkflowDeleteRequest, options: WorkflowLibraryServiceOptions = {}): Promise<ComfyUiWorkflowDeleteResponse> {
  const source = sourceFromWorkflowKey(request.workflowKey);
  if (source === 'built-in') return { ok: false, success: false, deleted: [], diagnostics: [diagnostic('/workflowKey', 'Built-in workflows cannot be deleted.')], error: 'Built-in workflows cannot be deleted.' };
  const library = await listComfyUiWorkflowLibrary({ projectFilePath: request.projectFilePath, includeOverridden: true }, options);
  const entry = library.entries.find((item) => item.workflowKey === request.workflowKey);
  if (!entry) return { ok: false, success: false, deleted: [], diagnostics: [diagnostic('/workflowKey', 'Workflow was not found.')], error: 'Workflow was not found.' };
  const deleted: string[] = [];
  for (const filePath of [entry.manifestPath, entry.workflowPath]) {
    if (!filePath) continue;
    await fs.rm(filePath, { force: true });
    deleted.push(filePath);
  }
  return { ok: true, success: true, deleted, workflowKey: request.workflowKey, refreshed: await listComfyUiWorkflowLibrary({ projectFilePath: request.projectFilePath, includeOverridden: true }, options), diagnostics: [] };
}

export async function revealComfyUiWorkflow(workflowKeyValue: ComfyUiWorkflowKey, projectFilePath?: string | null, options: WorkflowLibraryServiceOptions = {}) {
  const roots = resolveComfyUiWorkflowLibraryRoots(projectFilePath, options);
  const root = rootForSource(sourceFromWorkflowKey(workflowKeyValue), roots);
  if (!root) return false;
  const itemPath = path.join(root, manifestFileFromWorkflowKey(workflowKeyValue));
  await (options.showItemInFolder ?? shell.showItemInFolder)(itemPath);
  return true;
}
