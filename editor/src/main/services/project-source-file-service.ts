import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { parseMaterialData } from '../../shared/project-schema/authoring-materials';
import { PROJECT_TEXT_SOURCE_LIMITS } from '../../shared/project-text-sources';
import type {
  ProjectSourceExpectedRevision,
  ProjectSourceStructuralOperation,
  ProjectSourceStructuralResponse,
  ProjectSourceUsage,
  ProjectSourceWriteResponse,
} from '../../shared/project-source-files';
import {
  NodeProjectWorkspaceFileSystem,
  NodeProjectWorkspaceProcessLiveness,
} from '../../shared/project-workspace/node-project-workspace-file-system';
import {
  PROJECT_WORKSPACE_ABSENT_REVISION,
  ProjectWorkspaceMutationError,
  ProjectWorkspaceTransactionService,
  type ProjectWorkspaceTransactionTargetInput,
} from '../../shared/project-workspace/project-workspace-transaction';
import {
  projectWorkspaceFiles,
  type LoadedProjectWorkspaceSnapshot,
} from '../../shared/project-workspace/project-workspace-service';
import type { ActiveProjectWorkspaceSession } from './active-project-workspace-session';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function sourceRoot(value: string): 'scripts' | 'shaders' | null {
  if (value === 'scripts' || value.startsWith('scripts/')) return 'scripts';
  if (value === 'shaders' || value.startsWith('shaders/')) return 'shaders';
  return null;
}

function isSafeSourcePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('//')) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function assertSourcePath(value: string, allowRoot = false): void {
  const root = sourceRoot(value);
  if (!root || !isSafeSourcePath(value) || (!allowRoot && value === root))
    throw new ProjectWorkspaceMutationError(
      'WORKSPACE_PATH_INVALID',
      `Source path '${value}' must remain beneath scripts/ or shaders/.`,
      value,
    );
}

export function recreatableProjectSourcePhysicalPath(
  project: AuthoringProject,
  sourceId: string,
): string | null {
  const root = sourceRoot(sourceId);
  if (root && isSafeSourcePath(sourceId) && sourceId !== root) {
    if (root === 'scripts' && !sourceId.endsWith('.lua')) return null;
    return sourceId;
  }
  for (const [layoutId, record] of Object.entries(project.layouts)) {
    const data = record.data as unknown as Record<string, { sourceMode?: string }>;
    for (const channel of ['rml', 'rcss', 'lua'] as const) {
      if (
        sourceId === `layouts/${layoutId}/layout.${channel}` &&
        data[channel]?.sourceMode === 'inline'
      )
        return `records/layouts/${layoutId}/layout.${channel}`;
    }
  }
  return null;
}

function validateFileKind(pathValue: string, kind: 'lua' | 'shader'): void {
  assertSourcePath(pathValue);
  if (kind === 'lua' && (!pathValue.startsWith('scripts/') || !pathValue.endsWith('.lua')))
    throw new ProjectWorkspaceMutationError(
      'WORKSPACE_PATH_INVALID',
      'Lua source files must use a .lua path beneath scripts/.',
      pathValue,
    );
  if (kind === 'shader' && (!pathValue.startsWith('shaders/') || !pathValue.endsWith('.sc')))
    throw new ProjectWorkspaceMutationError(
      'WORKSPACE_PATH_INVALID',
      'Shader source files must use a .sc path beneath shaders/.',
      pathValue,
    );
}

function sourceTemplate(kind: 'lua' | 'shader'): string {
  return kind === 'lua' ? '-- NovelTea Lua source\n' : '#include "bgfx_shader.sh"\n\n';
}

function materialShaderCopyPath(materialId: string, stage: 'vertex' | 'fragment' | 'varying') {
  const suffix = stage === 'vertex' ? 'vs' : stage === 'fragment' ? 'fs' : 'varying';
  return `shaders/materials/${materialId}/${suffix}.sc`;
}

export async function readEngineShaderSource(sourceIdentity: string): Promise<string | null> {
  const filename = /^engine:\/([A-Za-z0-9_.-]+\.sc)$/u.exec(sourceIdentity)?.[1] ?? null;
  if (!filename) return null;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resourcesPath
      ? path.join(resourcesPath, 'editor-assets', 'system', 'shaders', 'bgfx', filename)
      : null,
    path.resolve(process.cwd(), 'engine', 'shaders', 'bgfx', filename),
    path.resolve(process.cwd(), '..', 'engine', 'shaders', 'bgfx', filename),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() && stat.size <= PROJECT_TEXT_SOURCE_LIMITS.maxSourceBytes)
        return await fs.readFile(candidate, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

async function materialShaderSourceText(
  root: string,
  sourceIdentity: string,
): Promise<string | null> {
  if (sourceIdentity.startsWith('engine:/')) return readEngineShaderSource(sourceIdentity);
  if (!sourceIdentity.startsWith('project:/')) return null;
  const relative = sourceIdentity.slice('project:/'.length);
  if (!relative.startsWith('shaders/')) return null;
  assertSourcePath(relative);
  const [rootRealPath, sourceRealPath] = await Promise.all([
    fs.realpath(root),
    fs.realpath(path.join(root, relative)),
  ]);
  const relativeRealPath = path.relative(rootRealPath, sourceRealPath);
  if (relativeRealPath.startsWith('..') || path.isAbsolute(relativeRealPath))
    throw new ProjectWorkspaceMutationError(
      'WORKSPACE_PATH_INVALID',
      `Shader source '${sourceIdentity}' resolves outside the active Project.`,
      relative,
    );
  const stat = await fs.stat(sourceRealPath);
  if (!stat.isFile() || stat.size > PROJECT_TEXT_SOURCE_LIMITS.maxSourceBytes)
    throw new Error(`Shader source '${sourceIdentity}' is unavailable or too large.`);
  return fs.readFile(sourceRealPath, 'utf8');
}

function revision(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function mappedPath(value: string, remap: ReadonlyMap<string, string>): string {
  return remap.get(value) ?? value;
}

function normalizedLayoutScriptReference(value: string): string | null {
  const normalized = value.startsWith('project:/') ? value.slice('project:/'.length) : value;
  return normalized.startsWith('scripts/') ? normalized : null;
}

function rewriteLayoutRmlScriptReferences(
  text: string,
  remap: ReadonlyMap<string, string>,
): string {
  return text.replace(
    /(<script\b[^>]*\bsrc\s*=\s*)(["'])([^"']+)\2/giu,
    (whole, prefix, quote, sourceValue) => {
      const normalized = normalizedLayoutScriptReference(String(sourceValue));
      if (!normalized) return whole;
      const next = mappedPath(normalized, remap);
      if (next === normalized) return whole;
      const rewritten = String(sourceValue).startsWith('project:/') ? `project:/${next}` : next;
      return `${prefix}${quote}${rewritten}${quote}`;
    },
  );
}

function moveRemapForFiles(
  fromPath: string,
  toPath: string,
  files: readonly string[],
): Map<string, string> {
  const remap = new Map<string, string>();
  for (const file of files) {
    if (file === fromPath) remap.set(file, toPath);
    else if (file.startsWith(`${fromPath}/`))
      remap.set(file, `${toPath}${file.slice(fromPath.length)}`);
  }
  return remap;
}

function rewriteSemanticPaths(
  project: AuthoringProject,
  scriptSourcePaths: Record<string, string>,
  remap: ReadonlyMap<string, string>,
): void {
  for (const record of Object.values(project.materials)) {
    const shader = (record.data as { shader?: Record<string, { kind?: string; path?: string }> })
      .shader;
    if (!shader) continue;
    for (const stage of ['vertex', 'fragment', 'varying'] as const) {
      const source = shader[stage];
      if (source?.kind !== 'project' || !source.path) continue;
      const next = mappedPath(source.path, remap);
      if (next !== source.path) source.path = next;
    }
  }
  for (const [scriptId, sourcePath] of Object.entries(scriptSourcePaths)) {
    const next = mappedPath(sourcePath, remap);
    if (next === sourcePath) continue;
    scriptSourcePaths[scriptId] = next;
    const record = project.scripts[scriptId];
    const data = record?.data as { source?: { kind?: string; path?: string } } | undefined;
    if (data?.source?.kind === 'project-file') data.source.path = next;
  }
  for (const record of Object.values(project.layouts)) {
    const data = record.data as {
      dependencies?: { scripts?: string[] };
      rml?: { sourceMode?: string; sourceText?: string };
    };
    const scripts = data.dependencies?.scripts;
    if (scripts) {
      const rewritten = scripts.map((sourcePath) => mappedPath(sourcePath, remap));
      data.dependencies!.scripts = [...new Set(rewritten)];
    }
    if (data.rml?.sourceMode === 'inline' && typeof data.rml.sourceText === 'string')
      data.rml.sourceText = rewriteLayoutRmlScriptReferences(data.rml.sourceText, remap);
  }
}

function relativeShaderInclude(fromFile: string, toFile: string, original: string): string {
  let result = path.posix.relative(path.posix.dirname(fromFile), toFile);
  if (!result.startsWith('.')) result = `./${result}`;
  if (!original.startsWith('./') && !original.startsWith('../')) return result.replace(/^\.\//, '');
  return result;
}

function resolveShaderInclude(
  sourceFile: string,
  include: string,
  existingShaderPaths: ReadonlySet<string>,
): string | null {
  if (
    include.startsWith('engine:/') ||
    include === 'bgfx_shader.sh' ||
    include === 'bgfx_compute.sh'
  )
    return null;
  if (path.posix.isAbsolute(include)) return null;
  const candidates = [
    path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), include)),
    path.posix.normalize(path.posix.join('shaders', include)),
  ];
  return (
    candidates.find(
      (candidate) => candidate.startsWith('shaders/') && existingShaderPaths.has(candidate),
    ) ?? null
  );
}

function rewriteShaderIncludes(
  text: string,
  oldConsumerPath: string,
  newConsumerPath: string,
  remap: ReadonlyMap<string, string>,
  existingShaderPaths: ReadonlySet<string>,
): string {
  return text.replace(
    /^(\s*#\s*include\s*[<"])([^">]+)([">])/gmu,
    (whole, prefix, include, suffix) => {
      const target = resolveShaderInclude(oldConsumerPath, String(include), existingShaderPaths);
      if (!target) return whole;
      const nextTarget = mappedPath(target, remap);
      if (nextTarget === target && newConsumerPath === oldConsumerPath) return whole;
      return `${prefix}${relativeShaderInclude(
        newConsumerPath,
        nextTarget,
        String(include),
      )}${suffix}`;
    },
  );
}

async function walkFiles(root: string, relative: string): Promise<string[]> {
  const absolute = path.join(root, relative);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const output: string[] = [];
  for (const entry of entries) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) output.push(...(await walkFiles(root, child)));
    else if (entry.isFile()) output.push(child);
  }
  return output.sort();
}

async function sourceFilesAtOrBelow(root: string, sourcePath: string): Promise<string[]> {
  const absolute = path.join(root, sourcePath);
  try {
    const stat = await fs.stat(absolute);
    if (stat.isFile()) return [sourcePath];
    if (stat.isDirectory()) return walkFiles(root, sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return [];
}

async function allShaderFiles(root: string): Promise<string[]> {
  return walkFiles(root, 'shaders');
}

export async function projectSourceUsages(
  root: string,
  snapshot: LoadedProjectWorkspaceSnapshot,
  sourcePath: string,
): Promise<ProjectSourceUsage[]> {
  const files = await sourceFilesAtOrBelow(root, sourcePath);
  const targets = new Set(files.length > 0 ? files : [sourcePath]);
  const usages: ProjectSourceUsage[] = [];
  for (const [materialId, record] of Object.entries(snapshot.project.materials)) {
    const shader = (record.data as { shader?: Record<string, { kind?: string; path?: string }> })
      .shader;
    if (!shader) continue;
    for (const stage of ['vertex', 'fragment', 'varying'] as const) {
      const source = shader[stage];
      if (source?.kind === 'project' && source.path && targets.has(source.path))
        usages.push({
          kind: 'material-shader',
          owner: `materials/${materialId}`,
          path: source.path,
          detail: `${stage} shader source`,
        });
    }
  }
  for (const [scriptId, source] of Object.entries(snapshot.scriptSourcePaths))
    if (targets.has(source))
      usages.push({
        kind: 'script-module',
        owner: `scripts/${scriptId}`,
        path: source,
        detail: 'Script Module project-file source',
      });
  for (const [layoutId, record] of Object.entries(snapshot.project.layouts)) {
    const data = record.data as {
      dependencies?: { scripts?: string[] };
      rml?: { sourceMode?: string; sourceText?: string };
    };
    for (const source of data.dependencies?.scripts ?? [])
      if (targets.has(source))
        usages.push({
          kind: 'layout-script-dependency',
          owner: `layouts/${layoutId}`,
          path: source,
          detail: 'Layout script dependency',
        });
    if (data.rml?.sourceMode !== 'inline' || typeof data.rml.sourceText !== 'string') continue;
    for (const match of data.rml.sourceText.matchAll(
      /<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1/giu,
    )) {
      const source = normalizedLayoutScriptReference(match[2]!);
      if (source && targets.has(source))
        usages.push({
          kind: 'layout-rml-script',
          owner: `layouts/${layoutId}`,
          path: source,
          detail: `RML <script src="${match[2]}">`,
        });
    }
  }
  const shaderFiles = await allShaderFiles(root);
  const existingShaderPaths = new Set(shaderFiles);
  for (const shaderPath of shaderFiles) {
    const text = await fs.readFile(path.join(root, shaderPath), 'utf8');
    for (const match of text.matchAll(/^\s*#\s*include\s*[<"]([^">]+)[">]/gmu)) {
      const target = resolveShaderInclude(shaderPath, match[1]!, existingShaderPaths);
      if (target && targets.has(target) && !targets.has(shaderPath))
        usages.push({
          kind: 'shader-include',
          owner: shaderPath,
          path: target,
          detail: `#include ${match[1]}`,
        });
    }
  }
  return usages.sort((a, b) => `${a.owner}:${a.path}`.localeCompare(`${b.owner}:${b.path}`));
}

async function currentExpectedRevision(
  fileSystem: NodeProjectWorkspaceFileSystem,
  root: string,
  relative: string,
): Promise<ProjectSourceExpectedRevision> {
  try {
    return (await fileSystem.readFileRevision(fileSystem.joinPath(root, relative))).contentHash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return PROJECT_WORKSPACE_ABSENT_REVISION;
    throw error;
  }
}

function transactionService(fileSystem: NodeProjectWorkspaceFileSystem) {
  return new ProjectWorkspaceTransactionService(
    fileSystem,
    new NodeProjectWorkspaceProcessLiveness(),
    process.pid,
  );
}

function changedProjectionTargets(
  snapshot: LoadedProjectWorkspaceSnapshot,
  project: AuthoringProject,
  scriptSourcePaths: Readonly<Record<string, string>>,
): string[] {
  const before = projectWorkspaceFiles(
    snapshot.project,
    snapshot.project.editor,
    snapshot.scriptSourcePaths,
  );
  const after = projectWorkspaceFiles(project, project.editor, scriptSourcePaths);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((file) => before[file] !== after[file])
    .sort();
}

export async function writeProjectSourceText(
  session: ActiveProjectWorkspaceSession,
  sourceId: string,
  physicalPath: string,
  expectedRevision: ProjectSourceExpectedRevision,
  text: string,
): Promise<ProjectSourceWriteResponse> {
  return session.runExclusive(async () => {
    const root = session.projectRoot();
    const fileSystem = new NodeProjectWorkspaceFileSystem();
    const bytes = encoder.encode(text);
    try {
      await transactionService(fileSystem).commit(root, {
        operationLabel: `save source ${sourceId}`,
        targets: [{ path: physicalPath, operation: 'write', expectedRevision, bytes }],
      });
      if (session.snapshot().canonicalSourceFiles.includes(physicalPath)) {
        const opened = await session.reassemble([physicalPath]);
        if (!opened.ok)
          return {
            ok: false,
            success: false,
            sourceId,
            error: opened.diagnostics[0]?.message ?? 'Saved source could not be reconciled.',
          };
      }
      return { ok: true, success: true, sourceId, contentHash: revision(bytes) };
    } catch (error) {
      return {
        ok: false,
        success: false,
        sourceId,
        error: error instanceof Error ? error.message : 'Source save failed.',
      };
    }
  });
}

export async function mutateProjectSources(
  session: ActiveProjectWorkspaceSession,
  operation: ProjectSourceStructuralOperation,
  expectedRevisions: Readonly<Record<string, ProjectSourceExpectedRevision>> = {},
): Promise<ProjectSourceStructuralResponse> {
  return session.runExclusive(async () => {
    const root = session.projectRoot();
    const snapshot = session.snapshot();
    const fileSystem = new NodeProjectWorkspaceFileSystem();
    try {
      if (operation.kind === 'create-folder') {
        assertSourcePath(operation.path);
        const absolute = fileSystem.joinPath(root, operation.path);
        if ((await fileSystem.inspect(absolute)) !== 'missing')
          throw new ProjectWorkspaceMutationError(
            'WORKSPACE_REVISION_CONFLICT',
            `Source destination '${operation.path}' already exists.`,
            operation.path,
          );
        await fileSystem.createDirectory(absolute);
        return { ok: true, success: true, changedPaths: [operation.path] };
      }
      if (operation.kind === 'create-file') {
        validateFileKind(operation.path, operation.fileKind);
        const bytes = encoder.encode(sourceTemplate(operation.fileKind));
        await transactionService(fileSystem).commit(root, {
          operationLabel: `create source ${operation.path}`,
          targets: [
            {
              path: operation.path,
              operation: 'write',
              expectedRevision: PROJECT_WORKSPACE_ABSENT_REVISION,
              bytes,
            },
          ],
        });
        return { ok: true, success: true, changedPaths: [operation.path] };
      }
      if (operation.kind === 'material-shader-copy') {
        const material = snapshot.project.materials[operation.materialId];
        const data = parseMaterialData(material?.data);
        if (!material || !data)
          throw new Error(`Material '${operation.materialId}' is unavailable or invalid.`);
        const sourceIdentity = operation.sourceIdentity;
        const sourceText = await materialShaderSourceText(root, sourceIdentity);
        if (sourceText === null)
          throw new Error(`Shader source '${sourceIdentity}' cannot be copied.`);
        const preferredDestination = materialShaderCopyPath(operation.materialId, operation.stage);
        let destination = preferredDestination;
        let copyIndex = 2;
        while (
          sourceIdentity === `project:/${destination}` ||
          (await fileSystem.inspect(fileSystem.joinPath(root, destination))) !== 'missing'
        ) {
          destination = preferredDestination.replace(/\.sc$/u, `-${copyIndex}.sc`);
          copyIndex += 1;
        }
        assertSourcePath(destination);
        const copiedSourceText = sourceIdentity.startsWith('project:/shaders/')
          ? rewriteShaderIncludes(
              sourceText,
              sourceIdentity.slice('project:/'.length),
              destination,
              new Map(),
              new Set(await allShaderFiles(root)),
            )
          : sourceText;
        const candidate = structuredClone(snapshot.project);
        const candidateData = parseMaterialData(candidate.materials[operation.materialId]?.data);
        if (!candidateData)
          throw new Error(`Material '${operation.materialId}' is unavailable or invalid.`);
        candidateData.shader = {
          ...candidateData.shader,
          [operation.stage]: { kind: 'project', path: destination },
        };
        candidate.materials[operation.materialId]!.data = candidateData;
        const targetFiles = changedProjectionTargets(
          snapshot,
          candidate,
          snapshot.scriptSourcePaths,
        );
        const expectedFileRevisions = Object.fromEntries(
          targetFiles.map((file) => [
            file,
            snapshot.fileRevisions[file]?.contentHash ?? PROJECT_WORKSPACE_ABSENT_REVISION,
          ]),
        );
        const written = await session
          .service()
          .write(
            root,
            snapshot.workspaceRevision,
            candidate,
            session.editorState(),
            snapshot.scriptSourcePaths,
            {
              expectedFileRevisions,
              targetFiles,
              operationLabel: `customize Material shader ${operation.materialId}:${operation.stage}`,
              extraTargets: [
                {
                  path: destination,
                  operation: 'write',
                  expectedRevision: PROJECT_WORKSPACE_ABSENT_REVISION,
                  bytes: encoder.encode(copiedSourceText),
                },
              ],
              preflightSnapshot: snapshot,
            },
          );
        session.adopt(written.snapshot, session.editorState());
        return {
          ok: true,
          success: true,
          changedPaths: [...new Set([...targetFiles, destination])].sort(),
          createdSourceIds: [destination],
        };
      }
      if (operation.kind === 'delete') {
        assertSourcePath(operation.path);
        const usages = await projectSourceUsages(root, snapshot, operation.path);
        if (usages.length > 0)
          return {
            ok: false,
            success: false,
            usages,
            error: `Source '${operation.path}' is still referenced.`,
          };
        const files = await sourceFilesAtOrBelow(root, operation.path);
        if (files.length === 0) {
          await fs.rm(path.join(root, operation.path), { recursive: true, force: false });
          return { ok: true, success: true, changedPaths: [operation.path] };
        }
        const targets: ProjectWorkspaceTransactionTargetInput[] = [];
        for (const file of files) {
          const current = await currentExpectedRevision(fileSystem, root, file);
          targets.push({
            path: file,
            operation: 'delete',
            expectedRevision: expectedRevisions[file] ?? current,
          });
        }
        await transactionService(fileSystem).commit(root, {
          operationLabel: `delete source ${operation.path}`,
          targets,
        });
        await fs.rm(path.join(root, operation.path), { recursive: true, force: true });
        return { ok: true, success: true, changedPaths: files };
      }

      assertSourcePath(operation.fromPath);
      assertSourcePath(operation.toPath);
      if (sourceRoot(operation.fromPath) !== sourceRoot(operation.toPath))
        throw new ProjectWorkspaceMutationError(
          'WORKSPACE_PATH_INVALID',
          'Source moves must remain within the same scripts/ or shaders/ root.',
        );
      const sourceAbsolute = fileSystem.joinPath(root, operation.fromPath);
      const sourceKind = await fileSystem.inspect(sourceAbsolute);
      const files = await sourceFilesAtOrBelow(root, operation.fromPath);
      if (sourceKind === 'missing')
        throw new Error(`Source '${operation.fromPath}' does not exist.`);
      if ((await fileSystem.inspect(fileSystem.joinPath(root, operation.toPath))) !== 'missing')
        throw new ProjectWorkspaceMutationError(
          'WORKSPACE_REVISION_CONFLICT',
          `Source destination '${operation.toPath}' already exists.`,
          operation.toPath,
        );
      if (sourceKind === 'directory' && files.length === 0) {
        await fs.mkdir(path.dirname(path.join(root, operation.toPath)), { recursive: true });
        await fs.rename(sourceAbsolute, path.join(root, operation.toPath));
        return {
          ok: true,
          success: true,
          pathRemap: {},
          changedPaths: [operation.fromPath, operation.toPath],
        };
      }
      const remap = moveRemapForFiles(operation.fromPath, operation.toPath, files);
      for (const target of remap.values()) assertSourcePath(target);

      const candidate = structuredClone(snapshot.project);
      const scriptSourcePaths = { ...snapshot.scriptSourcePaths };
      rewriteSemanticPaths(candidate, scriptSourcePaths, remap);
      const projectionTargets = changedProjectionTargets(snapshot, candidate, scriptSourcePaths);
      const extraTargets: ProjectWorkspaceTransactionTargetInput[] = [];
      const changedPaths = new Set<string>();
      const sourceBytes = new Map<string, Uint8Array>();
      for (const source of files)
        sourceBytes.set(source, await fileSystem.readBytes(path.join(root, source)));

      if (sourceRoot(operation.fromPath) === 'shaders') {
        const shaderFiles = await allShaderFiles(root);
        const existingShaderPaths = new Set(shaderFiles);
        for (const shaderPath of shaderFiles) {
          const oldBytes =
            sourceBytes.get(shaderPath) ??
            (await fileSystem.readBytes(path.join(root, shaderPath)));
          const oldText = decoder.decode(oldBytes);
          const newPath = mappedPath(shaderPath, remap);
          const newText = rewriteShaderIncludes(
            oldText,
            shaderPath,
            newPath,
            remap,
            existingShaderPaths,
          );
          const moved = newPath !== shaderPath;
          const rewritten = newText !== oldText;
          if (!moved && !rewritten) continue;
          const expected = expectedRevisions[shaderPath] ?? revision(oldBytes);
          extraTargets.push({
            path: newPath,
            operation: 'write',
            expectedRevision: moved ? PROJECT_WORKSPACE_ABSENT_REVISION : expected,
            bytes: encoder.encode(newText),
          });
          if (moved)
            extraTargets.push({
              path: shaderPath,
              operation: 'delete',
              expectedRevision: expected,
            });
          changedPaths.add(shaderPath);
          changedPaths.add(newPath);
        }
      } else {
        for (const [source, target] of remap) {
          const bytes = sourceBytes.get(source)!;
          const expected = expectedRevisions[source] ?? revision(bytes);
          extraTargets.push({
            path: target,
            operation: 'write',
            expectedRevision: PROJECT_WORKSPACE_ABSENT_REVISION,
            bytes,
          });
          extraTargets.push({ path: source, operation: 'delete', expectedRevision: expected });
          changedPaths.add(source);
          changedPaths.add(target);
        }
      }

      const targetFiles = projectionTargets;
      const expectedFileRevisions = Object.fromEntries(
        targetFiles.map((file) => [
          file,
          snapshot.fileRevisions[file]?.contentHash ?? PROJECT_WORKSPACE_ABSENT_REVISION,
        ]),
      );
      const written = await session
        .service()
        .write(
          root,
          snapshot.workspaceRevision,
          candidate,
          session.editorState(),
          scriptSourcePaths,
          {
            expectedFileRevisions,
            targetFiles,
            operationLabel: `move source ${operation.fromPath}`,
            extraTargets,
            preflightSnapshot: snapshot,
          },
        );
      session.adopt(written.snapshot, session.editorState());
      for (const file of targetFiles) changedPaths.add(file);
      await fs
        .rm(path.join(root, operation.fromPath), { recursive: true, force: true })
        .catch(() => undefined);
      return {
        ok: true,
        success: true,
        pathRemap: Object.fromEntries(remap),
        changedPaths: [...changedPaths].sort(),
      };
    } catch (error) {
      return {
        ok: false,
        success: false,
        error: error instanceof Error ? error.message : 'Source operation failed.',
      };
    }
  });
}
