import { z } from 'zod';
import { assetRefSchema } from './authoring-flow';
import { parseAssetData } from './authoring-assets';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const scriptModuleSourceSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('inline-lua'), source: z.string() }),
  strict({ kind: z.literal('asset'), asset: assetRefSchema }),
]);
export const scriptModuleDataSchema = strict({ kind: z.literal('script-module'), source: scriptModuleSourceSchema });
export type ScriptModuleData = z.infer<typeof scriptModuleDataSchema>;
export interface ScriptModuleSchemaDiagnostic { severity: 'error' | 'warning' | 'info'; path: string; message: string; category?: string }
const diagnostic = (path: string, message: string, severity: ScriptModuleSchemaDiagnostic['severity'] = 'error'): ScriptModuleSchemaDiagnostic => ({ path, message, severity, category: 'authoring-script-modules' });
export function parseScriptModuleData(value: unknown): ScriptModuleData | null { const parsed = scriptModuleDataSchema.safeParse(value); return parsed.success ? parsed.data : null; }
export function defaultScriptModuleData(): ScriptModuleData { return { kind: 'script-module', source: { kind: 'inline-lua', source: '' } }; }
export function validateScriptModuleData(project: AuthoringProject, scriptId: string, record: AuthoringRecordBase): ScriptModuleSchemaDiagnostic[] {
  const base = `/scripts/${scriptId}/data`; const parsed = scriptModuleDataSchema.safeParse(record.data);
  if (!parsed.success) return parsed.error.issues.map((issue) => diagnostic(`${base}/${issue.path.join('/')}`, issue.message));
  if (parsed.data.source.kind !== 'asset') return [];
  const asset = project.assets[parsed.data.source.asset.$ref.id];
  if (!asset) return [diagnostic(`${base}/source/asset/$ref`, `Missing asset '${parsed.data.source.asset.$ref.id}'.`)];
  if (parseAssetData(asset.data)?.kind !== 'script') return [diagnostic(`${base}/source/asset/$ref`, 'Script Module asset source must reference a script asset.')];
  return [];
}
