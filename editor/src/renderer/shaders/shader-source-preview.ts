import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { resolveMaterialData } from '../../shared/project-schema/authoring-materials';
import type { ProjectSourceFile } from '../../shared/project-source-files';
import type { ProjectSourceBuffer } from '@/project/project-source-store';

export interface ShaderSourceMaterialUsage {
  materialId: string;
  stage: 'vertex' | 'fragment' | 'varying';
  entrypointPath: string;
  kind: 'direct' | 'transitive';
}

export interface ShaderSourceMaterialUsages {
  direct: ShaderSourceMaterialUsage[];
  transitive: ShaderSourceMaterialUsage[];
  affectedMaterialIds: string[];
}

function projectShaderPath(identity: string | undefined): string | null {
  if (!identity) return null;
  if (identity.startsWith('project:/')) return identity.slice('project:/'.length);
  if (identity.startsWith('shaders/')) return identity;
  return null;
}

function normalizeShaderPath(value: string): string | null {
  const parts: string[] = [];
  for (const raw of value.replaceAll('\\', '/').split('/')) {
    if (!raw || raw === '.') continue;
    if (raw === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(raw);
  }
  const normalized = parts.join('/');
  return normalized === 'shaders' || normalized.startsWith('shaders/') ? normalized : null;
}

function parentDirectory(sourcePath: string) {
  const index = sourcePath.lastIndexOf('/');
  return index < 0 ? '' : sourcePath.slice(0, index);
}

function includeTargets(
  sourcePath: string,
  text: string,
  knownPaths: ReadonlySet<string>,
): string[] {
  const targets = new Set<string>();
  for (const match of text.matchAll(/^\s*#\s*include\s*[<"]([^">]+)[">]/gmu)) {
    const include = match[1]?.trim();
    if (!include || include === 'bgfx_shader.sh' || include === 'bgfx_compute.sh') continue;
    if (include.startsWith('engine:/')) continue;
    const relative = normalizeShaderPath(`${parentDirectory(sourcePath)}/${include}`);
    const rooted = normalizeShaderPath(`shaders/${include}`);
    if (relative && knownPaths.has(relative)) targets.add(relative);
    else if (rooted && knownPaths.has(rooted)) targets.add(rooted);
  }
  return [...targets];
}

function reachesSource(
  entrypointPath: string,
  targetPath: string,
  textByPath: Readonly<Record<string, string>>,
): boolean {
  const knownPaths = new Set(Object.keys(textByPath));
  const visiting = new Set<string>();
  const visit = (path: string): boolean => {
    if (path === targetPath) return true;
    if (visiting.has(path)) return false;
    visiting.add(path);
    const text = textByPath[path];
    if (text === undefined) return false;
    return includeTargets(path, text, knownPaths).some(visit);
  };
  return visit(entrypointPath);
}

export function discoverShaderSourceMaterialUsages(
  project: AuthoringProject,
  sourcePath: string,
  textByPath: Readonly<Record<string, string>>,
): ShaderSourceMaterialUsages {
  const targetPath = normalizeShaderPath(sourcePath);
  if (!targetPath) return { direct: [], transitive: [], affectedMaterialIds: [] };
  const direct: ShaderSourceMaterialUsage[] = [];
  const transitive: ShaderSourceMaterialUsage[] = [];

  for (const materialId of Object.keys(project.materials).sort()) {
    const resolved = resolveMaterialData(project, materialId).data;
    if (!resolved) continue;
    const stages = [
      ['vertex', projectShaderPath(resolved.vertexSource)],
      ['fragment', projectShaderPath(resolved.fragmentSource)],
      ['varying', projectShaderPath(resolved.varyingDefinition)],
    ] as const;
    for (const [stage, entrypoint] of stages) {
      if (!entrypoint) continue;
      const normalizedEntrypoint = normalizeShaderPath(entrypoint);
      if (!normalizedEntrypoint) continue;
      if (normalizedEntrypoint === targetPath) {
        direct.push({ materialId, stage, entrypointPath: normalizedEntrypoint, kind: 'direct' });
      } else if (reachesSource(normalizedEntrypoint, targetPath, textByPath)) {
        transitive.push({
          materialId,
          stage,
          entrypointPath: normalizedEntrypoint,
          kind: 'transitive',
        });
      }
    }
  }

  const affectedMaterialIds = [
    ...new Set([...direct, ...transitive].map((usage) => usage.materialId)),
  ].sort();
  return { direct, transitive, affectedMaterialIds };
}

export class DebouncedShaderPreviewCompiler<T> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Array<{ resolve: (value: T) => void; reject: (error: unknown) => void }> = [];
  private latestRun: (() => Promise<T>) | null = null;

  constructor(private readonly delayMs = 180) {}

  run(run: () => Promise<T>): Promise<T> {
    this.latestRun = run;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const pending = this.pending.splice(0);
      const execute = this.latestRun!;
      this.latestRun = null;
      void execute().then(
        (value) => pending.forEach(({ resolve }) => resolve(value)),
        (error) => pending.forEach(({ reject }) => reject(error)),
      );
    }, this.delayMs);
    return new Promise<T>((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.latestRun = null;
    const pending = this.pending.splice(0);
    for (const { reject } of pending)
      reject(new Error('Shader preview compilation was cancelled.'));
  }
}

export function shaderSourcePreviewAuthorityKey(
  attachedMaterialIds: readonly string[],
  overlays: Readonly<Record<string, string>>,
  files: readonly Pick<ProjectSourceFile, 'id' | 'kind' | 'contentHash'>[],
): string {
  const persistedShaderRevisions = files
    .filter((file) => file.kind === 'shader')
    .map((file) => `${file.id}:${file.contentHash ?? 'absent'}`)
    .sort();
  return JSON.stringify({
    attachedMaterialIds: [...attachedMaterialIds],
    overlays,
    persistedShaderRevisions,
  });
}

export function shaderSourceOverlays(
  files: readonly Pick<ProjectSourceFile, 'id' | 'kind' | 'text'>[],
  buffersById: Readonly<Record<string, ProjectSourceBuffer>>,
): Record<string, string> {
  return Object.fromEntries(
    files.flatMap((file) => {
      if (file.kind !== 'shader' || !file.text) return [];
      const buffer = buffersById[file.id];
      return buffer?.dirty ? [[file.id, buffer.text] as const] : [];
    }),
  );
}
