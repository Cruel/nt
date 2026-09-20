import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { useProjectStore } from '@/project/project-store';
import {
  parseScriptModuleData,
  scriptModuleLifecycleMetadata,
} from '../../../shared/project-schema/authoring-script-modules';
import { authoringProjectFromDocument } from '@/editors/interactions/InteractionProgramEditor';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';

export function ScriptModuleEditor({ tab }: WorkbenchEditorProps) {
  const document = useProjectStore((state) => state.document);
  const project = authoringProjectFromDocument(document);
  const id = tab.resource?.entityId;
  const record = id && project ? project.scripts[id] : null;
  const data = parseScriptModuleData(record?.data);
  if (!project || !id || !record || !data)
    return <div className="p-4 text-sm text-muted-foreground">Script Module record not found.</div>;
  const lifecycle = scriptModuleLifecycleMetadata(data);
  const commit = (next: typeof data) =>
    useCommandStore.getState().executeCommand({
      type: 'script.replaceData',
      label: 'Update Script Module',
      payload: { scriptId: id, data: next },
      originSaveUnitId: recordSaveUnitId('scripts', id),
      persistencePolicy: 'manual-save',
    });
  return (
    <div className="h-full overflow-auto bg-background p-4">
      <div className="mb-4 flex flex-wrap gap-2">
        <h2 className="text-lg font-semibold">{record.label}</h2>
        <Badge variant="outline">{id}</Badge>
        {lifecycle.onGameReady === 'declared' ? (
          <Badge variant="secondary">On Game Ready</Badge>
        ) : null}
        {lifecycle.literalImports.length ? (
          <Badge variant="outline">
            {lifecycle.literalImports.length} literal import
            {lifecycle.literalImports.length === 1 ? '' : 's'}
          </Badge>
        ) : null}
        {lifecycle.onGameReady === 'unknown' ? (
          <Badge variant="outline">Lifecycle metadata resolved from source</Badge>
        ) : null}
      </div>
      <div className="space-y-3">
        <Label>Source</Label>
        <Select
          value={data.source.kind}
          onValueChange={(kind) =>
            commit(
              kind === 'project-file'
                ? { ...data, source: { kind: 'project-file', path: `scripts/${id}.lua` } }
                : { ...data, source: { kind: 'inline-lua', source: '' } },
            )
          }
        >
          <SelectItem value="inline-lua">Inline Lua</SelectItem>
          <SelectItem value="project-file">Project file</SelectItem>
        </Select>
        {data.source.kind === 'inline-lua' ? (
          <textarea
            className="min-h-64 w-full rounded border bg-background p-2 font-mono text-sm"
            value={data.source.source}
            onChange={(event) =>
              commit({ ...data, source: { kind: 'inline-lua', source: event.currentTarget.value } })
            }
          />
        ) : (
          <div className="space-y-1">
            <Label>Project-relative Lua path</Label>
            <Input
              value={data.source.path}
              onChange={(event) =>
                commit({
                  ...data,
                  source: { kind: 'project-file', path: event.currentTarget.value },
                })
              }
            />
            <p className="text-xs text-muted-foreground">
              Source files must remain under scripts/ and use a .lua extension.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
