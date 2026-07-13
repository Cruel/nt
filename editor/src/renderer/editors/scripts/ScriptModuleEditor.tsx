import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { parseScriptModuleData } from '../../../shared/project-schema/authoring-script-modules';
import { authoringProjectFromDocument, typedRef, type AuthoringEditorProject } from '@/editors/interactions/InteractionProgramEditor';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';

export function ScriptModuleEditor({ tab }: WorkbenchEditorProps) {
  const document = useProjectStore((state) => state.document); const project = authoringProjectFromDocument(document); const id = tab.resource?.entityId; const record = id && project ? project.scripts[id] : null; const data = parseScriptModuleData(record?.data);
  if (!project || !id || !record || !data) return <div className="p-4 text-sm text-muted-foreground">Script Module record not found.</div>;
  const commit = (next: typeof data) => useCommandStore.getState().executeCommand({ type: 'script.replaceData', label: 'Update Script Module', payload: { scriptId: id, data: next } });
  return <div className="h-full overflow-auto bg-background p-4"><div className="mb-4 flex gap-2"><h2 className="text-lg font-semibold">{record.label}</h2><Badge variant="outline">{id}</Badge></div><ScriptModuleForm data={data} project={project} onChange={commit} /></div>;
}

function ScriptModuleForm({ data, project, onChange }: { data: NonNullable<ReturnType<typeof parseScriptModuleData>>; project: AuthoringEditorProject; onChange: (next: NonNullable<ReturnType<typeof parseScriptModuleData>>) => void }) {
  const scriptAssets = Object.entries(project.assets).filter(([, record]) => (record.data as { kind?: string }).kind === 'script');
  return <div className="space-y-3"><Label>Source</Label><Select value={data.source.kind} onValueChange={(kind) => onChange(kind === 'asset' && scriptAssets[0] ? { ...data, source: { kind: 'asset', asset: typedRef('assets', scriptAssets[0][0]) } } : { ...data, source: { kind: 'inline-lua', source: '' } })}><SelectItem value="inline-lua">Inline Lua</SelectItem><SelectItem value="asset" disabled={!scriptAssets.length}>Script asset</SelectItem></Select>{data.source.kind === 'inline-lua' ? <textarea className="min-h-64 w-full rounded border bg-background p-2 font-mono text-sm" value={data.source.source} onChange={(event) => onChange({ ...data, source: { kind: 'inline-lua', source: event.currentTarget.value } })} /> : <Select value={data.source.asset.$ref.id} onValueChange={(assetId) => onChange({ ...data, source: { kind: 'asset', asset: typedRef('assets', String(assetId)) } })}>{scriptAssets.map(([assetId, asset]) => <SelectItem key={assetId} value={assetId}>{asset.label}</SelectItem>)}</Select>}</div>;
}
