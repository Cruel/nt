import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import type { ProjectSourceUsage } from '../../shared/project-source-files';

export type ProjectSourceUsageView = Readonly<{
  project: Pick<AuthoringProject, 'materials' | 'scripts' | 'layouts'>;
  scriptSourcePaths: Readonly<Record<string, string>>;
}>;

export function normalizedLayoutScriptReference(value: string): string | null {
  const normalized = value.startsWith('project:/') ? value.slice('project:/'.length) : value;
  return normalized.startsWith('scripts/') ? normalized : null;
}

export function resolveShaderInclude(
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

export async function sourceFilesAtOrBelow(root: string, sourcePath: string): Promise<string[]> {
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

export async function allShaderFiles(root: string): Promise<string[]> {
  return walkFiles(root, 'shaders');
}

/** A downstream usage presenter over an already admitted Project. It never
 * parses YAML, normalizes a Project or instantiates a workspace transaction. */
export async function projectSourceUsages(
  root: string,
  snapshot: ProjectSourceUsageView,
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
