import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import { PROJECT_TEXT_SOURCE_LIMITS } from '../../shared/project-text-sources';
import {
  normalizedLayoutScriptReference,
  resolveShaderInclude,
} from './project-source-usage-reader';

/** Physical source planning for both the legacy editor and native transactions.
 * No Workspace reader, Project parser, watcher or transaction writer belongs here. */
export function sourceTemplate(kind: 'lua' | 'shader'): string {
  return kind === 'lua' ? '-- NovelTea Lua source\n' : '#include "bgfx_shader.sh"\n\n';
}

export function materialShaderCopyPath(
  materialId: string,
  stage: 'vertex' | 'fragment' | 'varying',
) {
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

/** Native planner reads only a contained source and delegates writes to the
 * worker's revision-checked transaction. Never follow a symlink component. */
export async function materialShaderSourceText(
  root: string,
  sourceIdentity: string,
): Promise<string | null> {
  if (sourceIdentity.startsWith('engine:/')) return readEngineShaderSource(sourceIdentity);
  if (!sourceIdentity.startsWith('project:/')) return null;
  const relative = sourceIdentity.slice('project:/'.length);
  if (
    !relative.startsWith('shaders/') ||
    relative.includes('\\') ||
    relative.split('/').some((part) => part === '.' || part === '..' || !part)
  )
    throw new Error('Invalid Project shader source path.');
  const canonicalRoot = await fs.realpath(root);
  const sourceRealPath = await fs.realpath(path.join(canonicalRoot, relative));
  if (sourceRealPath !== path.join(canonicalRoot, relative))
    throw new Error('Project shader source must not traverse symbolic links.');
  const stat = await fs.stat(sourceRealPath);
  if (!stat.isFile() || stat.size > PROJECT_TEXT_SOURCE_LIMITS.maxSourceBytes)
    throw new Error(`Shader source '${sourceIdentity}' is unavailable or too large.`);
  return fs.readFile(sourceRealPath, 'utf8');
}

export function mappedPath(value: string, remap: ReadonlyMap<string, string>): string {
  return remap.get(value) ?? value;
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

export function rewriteSemanticPaths(
  project: AuthoringProject,
  scriptSourcePaths: Record<string, string>,
  remap: ReadonlyMap<string, string>,
): void {
  const distributionNotices = project.settings.distributionNotices;
  if (Array.isArray(distributionNotices)) {
    project.settings.distributionNotices = distributionNotices.map((notice) =>
      notice && typeof notice === 'object' && typeof notice.path === 'string'
        ? { ...notice, path: mappedPath(notice.path, remap) }
        : notice,
    );
    const paths = project.settings.distributionNotices.map((notice) => notice.path);
    if (new Set(paths).size !== paths.length)
      throw new Error('Source move would create duplicate Project distribution notices.');
  }
  for (const record of Object.values(project.assets)) {
    const data = parseAssetData(record.data);
    if (!data) continue;
    const sourcePath = mappedPath(data.source.path, remap);
    const attachments = data.attachments.map((attachment) => ({
      ...attachment,
      path: mappedPath(attachment.path, remap),
    }));
    if (
      sourcePath !== data.source.path ||
      attachments.some((attachment, index) => attachment.path !== data.attachments[index]?.path)
    ) {
      if (new Set(attachments.map((attachment) => attachment.path)).size !== attachments.length)
        throw new Error(`Source move would create duplicate attachments on Asset '${record.id}'.`);
      record.data = { ...data, source: { ...data.source, path: sourcePath }, attachments };
    }
  }
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

export function rewriteShaderIncludes(
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
