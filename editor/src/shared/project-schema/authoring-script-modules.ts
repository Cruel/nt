import { z } from 'zod';
import { assetRefSchema } from './authoring-flow';
import { parseAssetData } from './authoring-assets';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const scriptModuleSourceSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('inline-lua'), source: z.string() }),
  strict({ kind: z.literal('asset'), asset: assetRefSchema }),
]);
export const scriptModuleDataSchema = strict({
  kind: z.literal('script-module'),
  source: scriptModuleSourceSchema,
});
export type ScriptModuleData = z.infer<typeof scriptModuleDataSchema>;
export interface ScriptModuleSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

export interface ScriptModuleLifecycleMetadata {
  onGameReady: 'declared' | 'not-declared' | 'unknown';
  literalImports: readonly string[];
}

const literalImports = (source: string): string[] => {
  const imports: string[] = [];
  const matcher = /(?:^|[^\w.])import\s*\(\s*(['"])([^'"\r\n]+)\1/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(source)) !== null) {
    if (match[2] && !imports.includes(match[2])) imports.push(match[2]);
  }
  return imports;
};

export function scriptModuleLifecycleMetadata(
  data: ScriptModuleData,
): ScriptModuleLifecycleMetadata {
  if (data.source.kind !== 'inline-lua') return { onGameReady: 'unknown', literalImports: [] };
  return {
    onGameReady: /\bon_ready\s*=/.test(data.source.source) ? 'declared' : 'not-declared',
    literalImports: literalImports(data.source.source),
  };
}

const diagnostic = (
  path: string,
  message: string,
  severity: ScriptModuleSchemaDiagnostic['severity'] = 'error',
): ScriptModuleSchemaDiagnostic => ({ path, message, severity, category: 'Scripts' });
export function parseScriptModuleData(value: unknown): ScriptModuleData | null {
  const parsed = scriptModuleDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function defaultScriptModuleData(): ScriptModuleData {
  return { kind: 'script-module', source: { kind: 'inline-lua', source: '' } };
}
export function validateScriptModuleData(
  project: AuthoringProject,
  scriptId: string,
  record: AuthoringRecordBase,
): ScriptModuleSchemaDiagnostic[] {
  const base = `/scripts/${scriptId}/data`;
  const parsed = scriptModuleDataSchema.safeParse(record.data);
  if (!parsed.success)
    return parsed.error.issues.map((issue) =>
      diagnostic(`${base}/${issue.path.join('/')}`, issue.message),
    );
  if (parsed.data.source.kind === 'inline-lua') {
    const imports = literalImports(parsed.data.source.source);
    const diagnostics = imports
      .filter((dependency) => !project.scripts[dependency])
      .map((dependency) =>
        diagnostic(
          `${base}/source/source`,
          `Script Module imports missing Script Module '${dependency}'.`,
        ),
      );
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      const dependencyData = parseScriptModuleData(project.scripts[id]?.data);
      if (dependencyData?.source.kind === 'inline-lua') {
        for (const dependency of literalImports(dependencyData.source.source)) {
          if (project.scripts[dependency] && visit(dependency)) return true;
        }
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    if (visit(scriptId))
      diagnostics.push(
        diagnostic(`${base}/source/source`, 'Script Module literal imports contain a cycle.'),
      );
    return diagnostics;
  }
  const asset = project.assets[parsed.data.source.asset.$ref.id];
  if (!asset)
    return [
      diagnostic(
        `${base}/source/asset/$ref`,
        `Missing asset '${parsed.data.source.asset.$ref.id}'.`,
      ),
    ];
  if (parseAssetData(asset.data)?.kind !== 'script')
    return [
      diagnostic(
        `${base}/source/asset/$ref`,
        'Script Module asset source must reference a script asset.',
      ),
    ];
  return [];
}
