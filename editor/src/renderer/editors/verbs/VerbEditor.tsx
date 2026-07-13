import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import type { Condition, TextContent } from '../../../shared/project-schema/authoring-flow';
import { parseVerbData } from '../../../shared/project-schema/authoring-verbs';
import {
  authoringProjectFromDocument,
  InteractionProgramEditor,
  typedRef,
  type AuthoringEditorProject,
} from '@/editors/interactions/InteractionProgramEditor';

type VerbData = NonNullable<ReturnType<typeof parseVerbData>>;

function TextContentEditor({ value, onChange }: { value: TextContent; onChange: (next: TextContent) => void }) {
  return (
    <div className="grid gap-2 md:grid-cols-3">
      <Select
        value={value.source.kind}
        onValueChange={(kind) => {
          if (kind === 'localized') onChange({ ...value, source: { kind, key: 'text-key' } });
          else if (kind === 'lua-expression') onChange({ ...value, source: { kind, source: 'return ""' } });
          else onChange({ ...value, source: { kind: 'inline', text: '' } });
        }}
      >
        <SelectItem value="inline">Inline</SelectItem>
        <SelectItem value="localized">Localized key</SelectItem>
        <SelectItem value="lua-expression">Lua expression</SelectItem>
      </Select>
      <Input
        value={value.source.kind === 'inline' ? value.source.text : value.source.kind === 'localized' ? value.source.key : value.source.source}
        onChange={(event) => {
          if (value.source.kind === 'inline') onChange({ ...value, source: { kind: 'inline', text: event.currentTarget.value } });
          else if (value.source.kind === 'localized') onChange({ ...value, source: { kind: 'localized', key: event.currentTarget.value } });
          else onChange({ ...value, source: { kind: 'lua-expression', source: event.currentTarget.value || ' ' } });
        }}
      />
      <Select value={value.markup} onValueChange={(markup) => onChange({ ...value, markup: markup as TextContent['markup'] })}>
        <SelectItem value="plain">Plain</SelectItem>
        <SelectItem value="active-text">Active text</SelectItem>
      </Select>
    </div>
  );
}

function ConditionEditor({ value, project, onChange }: { value: Condition; project: AuthoringEditorProject; onChange: (next: Condition) => void }) {
  const variables = Object.entries(project.variables);
  return (
    <div className="grid gap-2 md:grid-cols-4">
      <Select
        value={value.kind}
        onValueChange={(kind) => {
          if (kind === 'variable-comparison' && variables[0]) onChange({ kind, variable: typedRef('variables', variables[0][0]), operator: 'truthy' });
          else if (kind === 'lua-predicate') onChange({ kind, source: 'return true' });
          else onChange({ kind: 'always' });
        }}
      >
        <SelectItem value="always">Always</SelectItem>
        <SelectItem value="variable-comparison" disabled={!variables.length}>Variable comparison</SelectItem>
        <SelectItem value="lua-predicate">Lua predicate</SelectItem>
      </Select>
      {value.kind === 'lua-predicate' && <Input value={value.source} onChange={(event) => onChange({ kind: 'lua-predicate', source: event.currentTarget.value || ' ' })} />}
      {value.kind === 'variable-comparison' && (
        <>
          <Select value={value.variable.$ref.id} onValueChange={(id) => onChange({ ...value, variable: typedRef('variables', String(id)) })}>
            {variables.map(([id, record]) => <SelectItem value={id} key={id}>{record.label}</SelectItem>)}
          </Select>
          <Select value={value.operator} onValueChange={(operator) => onChange({ ...value, operator: operator as typeof value.operator })}>
            {['equal', 'not-equal', 'less', 'less-equal', 'greater', 'greater-equal', 'truthy', 'falsy'].map((operator) => <SelectItem value={operator} key={operator}>{operator}</SelectItem>)}
          </Select>
          {!['truthy', 'falsy'].includes(value.operator) && <Input value={String(value.value ?? '')} onChange={(event) => onChange({ ...value, value: event.currentTarget.value })} />}
        </>
      )}
    </div>
  );
}

function VerbForm({ data, project, onChange }: { data: VerbData; project: AuthoringEditorProject; onChange: (next: VerbData) => void }) {
  const setArity = (value: string | null) => {
    const arity = Number(value ?? 0) as 0 | 1 | 2;
    onChange({ ...data, arity, operandRoles: Array.from({ length: arity }, (_, index) => data.operandRoles[index] ?? `operand-${index + 1}`) });
  };
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <div><Label>Arity</Label><Select value={String(data.arity)} onValueChange={setArity}><SelectItem value="0">0</SelectItem><SelectItem value="1">1</SelectItem><SelectItem value="2">2</SelectItem></Select></div>
        <label className="flex items-end gap-2 text-sm"><input type="checkbox" checked={data.quickAction} onChange={(event) => onChange({ ...data, quickAction: event.currentTarget.checked })} />Quick action</label>
      </div>
      <div><Label>Action text</Label><TextContentEditor value={data.actionText} onChange={(actionText) => onChange({ ...data, actionText })} /></div>
      {data.operandRoles.map((role, index) => <div key={index}><Label>Operand {index + 1} role</Label><Input value={role} onChange={(event) => onChange({ ...data, operandRoles: data.operandRoles.map((current, item) => item === index ? event.currentTarget.value : current) })} /></div>)}
      <div><Label>Availability</Label><ConditionEditor value={data.availability} project={project} onChange={(availability) => onChange({ ...data, availability })} /></div>
      <section><h3 className="mb-2 text-sm font-medium">Default Interaction Program</h3><InteractionProgramEditor value={data.defaultProgram} project={project} onChange={(defaultProgram) => onChange({ ...data, defaultProgram })} /></section>
    </div>
  );
}

export function VerbEditor({ tab }: WorkbenchEditorProps) {
  const document = useProjectStore((state) => state.document);
  const project = authoringProjectFromDocument(document);
  const id = tab.resource?.entityId;
  const record = id && project ? project.verbs[id] : null;
  const data = parseVerbData(record?.data);
  if (!project || !id || !record || !data) return <div className="p-4 text-sm text-muted-foreground">Verb record not found.</div>;
  const commit = (next: VerbData) => useCommandStore.getState().executeCommand({ type: 'verb.replaceData', label: 'Update verb', payload: { verbId: id, data: next } });
  return <div className="h-full overflow-auto bg-background p-4"><div className="mb-4 flex gap-2"><h2 className="text-lg font-semibold">{record.label}</h2><Badge variant="outline">{id}</Badge></div><VerbForm data={data} project={project} onChange={commit} /></div>;
}
