import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useEntityUsagesStore } from '@/project/entity-usages-store';
import { buildReferenceIndex, findUsages } from '@/project/reference-index';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import { isAuthoringProject, type AuthoringRecordBase } from '../../../shared/project-schema/authoring-project';
import {
  defaultVariableData,
  parseEnumValuesText,
  parseVariableData,
  parseVariableDefaultText,
  variableDefaultValueToText,
  variableTypeValues,
  type VariableData,
  type VariableType,
} from '../../../shared/project-schema/authoring-variables';

function variableDataFromRecord(record: AuthoringRecordBase): VariableData | null {
  return parseVariableData(record.data);
}

function createVariableDataFromText(
  type: VariableType,
  defaultText: string,
  enumText: string,
): { ok: true; data: VariableData } | { ok: false; message: string } {
  const enumValues = type === 'enum' ? parseEnumValuesText(enumText) : undefined;
  if (type === 'enum' && (!enumValues || enumValues.length === 0)) {
    return { ok: false, message: 'Enum variables require at least one value.' };
  }
  const defaultResult = parseVariableDefaultText(type, defaultText, enumValues);
  if (!defaultResult.ok) return defaultResult;
  return {
    ok: true,
    data: {
      ...defaultVariableData(type),
      enumValues,
      defaultValue: defaultResult.value,
    },
  };
}

function typeLabel(type: VariableType) {
  if (type === 'boolean') return 'Boolean';
  if (type === 'integer') return 'Integer';
  if (type === 'number') return 'Number';
  if (type === 'string') return 'String';
  return 'Enum';
}

function VariableRow({
  variableId,
  record,
  usages,
  onDelete,
}: {
  variableId: string;
  record: AuthoringRecordBase;
  usages: ReturnType<typeof findUsages>;
  onDelete: (variableId: string, usages: ReturnType<typeof findUsages>) => void;
}) {
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const setUsages = useEntityUsagesStore((state) => state.setUsages);
  const setActiveBottomPanel = useBottomPanelStore((state) => state.setActivePanelId);
  const data = variableDataFromRecord(record);
  const [label, setLabel] = useState(record.label);
  const [description, setDescription] = useState(record.description ?? '');
  const [renameId, setRenameId] = useState(variableId);
  const [defaultText, setDefaultText] = useState(data ? variableDefaultValueToText(data.defaultValue) : '');
  const [enumText, setEnumText] = useState(data?.enumValues?.join(', ') ?? '');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setLabel(record.label);
    setDescription(record.description ?? '');
    setRenameId(variableId);
    setDefaultText(data ? variableDefaultValueToText(data.defaultValue) : '');
    setEnumText(data?.enumValues?.join(', ') ?? '');
  }, [data, record.description, record.label, variableId]);

  function run(command: Parameters<typeof executeCommand>[0]) {
    const result = executeCommand(command);
    const failure = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    setMessage(failure?.message ?? null);
    return result.ok && !failure;
  }

  function updateMetadata() {
    run({
      type: 'entity.updateMetadata',
      label: `Update variable ${variableId}`,
      payload: {
        collection: 'variables',
        entityId: variableId,
        label: label.trim() || variableId,
        description: description.trim() || undefined,
      },
    });
  }

  function updateData(nextData: VariableData) {
    run({
      type: 'variable.replaceData',
      label: `Update variable ${variableId}`,
      payload: { variableId, data: nextData },
    });
  }

  function updateType(nextType: VariableType) {
    run({
      type: 'variable.setType',
      label: `Set variable ${variableId} type`,
      payload: {
        variableId,
        type: nextType,
        enumValues: nextType === 'enum' ? parseEnumValuesText(enumText || 'default') : undefined,
      },
    });
  }

  function updateDefault() {
    if (!data) return;
    const nextEnumValues = data.type === 'enum' ? parseEnumValuesText(enumText) : data.enumValues;
    const parsed = parseVariableDefaultText(data.type, defaultText, nextEnumValues);
    if (!parsed.ok) {
      setMessage(parsed.message);
      return;
    }
    updateData({ ...data, enumValues: nextEnumValues, defaultValue: parsed.value });
  }

  function rename() {
    const toId = renameId.trim();
    if (!toId || toId === variableId) return;
    run({
      type: 'entity.renameId',
      label: `Rename variable ${variableId}`,
      payload: { collection: 'variables', fromId: variableId, toId, label: label.trim() || undefined },
    });
  }

  function showUsages() {
    setUsages({ collection: 'variables', id: variableId }, usages);
    setActiveBottomPanel('references');
  }

  if (!data) {
    return (
      <tr className="border-t align-top">
        <td className="p-2 font-mono text-xs">{variableId}</td>
        <td className="p-2" colSpan={5}>
          <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">Invalid variable data.</div>
        </td>
        <td className="p-2 text-right">
          <span className="text-xs text-muted-foreground">Invalid data</span>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-t align-top">
      <td className="space-y-2 p-2">
        <div className="font-mono text-xs">{variableId}</div>
        <div className="flex gap-1">
          <Input aria-label={`Rename ${variableId}`} value={renameId} onChange={(event) => setRenameId(event.currentTarget.value)} className="h-8 min-w-32 font-mono text-xs" />
          <Button size="sm" variant="outline" onClick={rename} disabled={renameId.trim() === variableId}>Rename</Button>
        </div>
      </td>
      <td className="space-y-2 p-2">
        <Input aria-label={`Label ${variableId}`} value={label} onChange={(event) => setLabel(event.currentTarget.value)} onBlur={updateMetadata} className="h-8" />
        <Input aria-label={`Description ${variableId}`} value={description} onChange={(event) => setDescription(event.currentTarget.value)} onBlur={updateMetadata} placeholder="Description" className="h-8" />
      </td>
      <td className="p-2">
        <Select value={data.type} onValueChange={(value) => updateType(value as VariableType)}>
          {variableTypeValues.map((type) => <SelectItem key={type} value={type}>{typeLabel(type)}</SelectItem>)}
        </Select>
      </td>
      <td className="space-y-2 p-2">
        {data.type === 'enum' ? (
          <Input aria-label={`Enum values ${variableId}`} value={enumText} onChange={(event) => setEnumText(event.currentTarget.value)} onBlur={updateDefault} placeholder="idle, active" className="h-8" />
        ) : null}
        <Input aria-label={`Default ${variableId}`} value={defaultText} onChange={(event) => setDefaultText(event.currentTarget.value)} onBlur={updateDefault} className="h-8" />
        {message ? <div className="text-xs text-destructive">{message}</div> : null}
      </td>
      <td className="p-2">
        <Button size="sm" variant="outline" onClick={showUsages}>{usages.length} usage{usages.length === 1 ? '' : 's'}</Button>
      </td>
      <td className="p-2">
        <Badge variant="secondary">{data.scope ?? 'global'}</Badge>
      </td>
      <td className="space-x-2 whitespace-nowrap p-2 text-right">
        <Button size="sm" variant="destructive" onClick={() => onDelete(variableId, usages)}>Delete</Button>
      </td>
    </tr>
  );
}

export function VariablesEditor(_props: WorkbenchEditorProps) {
  const projectDocument = useProjectStore((state) => state.document);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const [createId, setCreateId] = useState('');
  const [createLabel, setCreateLabel] = useState('');
  const [createType, setCreateType] = useState<VariableType>('boolean');
  const [createDefault, setCreateDefault] = useState('false');
  const [createEnumValues, setCreateEnumValues] = useState('default');
  const [message, setMessage] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ variableId: string; usages: ReturnType<typeof findUsages> } | null>(null);

  const referenceIndex = useMemo(() => project ? buildReferenceIndex(project) : null, [project]);
  const variables = useMemo(() => {
    if (!project || !referenceIndex) return [];
    return Object.entries(project.variables)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, record]) => ({ id, record, usages: findUsages(referenceIndex, { collection: 'variables', id }) }));
  }, [project, referenceIndex]);

  useEffect(() => {
    setCreateDefault(variableDefaultValueToText(defaultVariableData(createType).defaultValue));
    setCreateEnumValues(createType === 'enum' ? 'default' : '');
  }, [createType]);

  function run(command: Parameters<typeof executeCommand>[0]) {
    const result = executeCommand(command);
    const failure = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    setMessage(failure?.message ?? null);
    return result.ok && !failure;
  }

  function createVariable() {
    const entityId = createId.trim();
    const data = createVariableDataFromText(createType, createDefault, createEnumValues);
    if (!data.ok) {
      setMessage(data.message);
      return;
    }
    if (run({
      type: 'entity.createRecord',
      label: `Create variable ${entityId}`,
      payload: {
        collection: 'variables',
        entityId,
        label: createLabel.trim() || entityId,
        data: data.data,
      },
    })) {
      setCreateId('');
      setCreateLabel('');
      setMessage(null);
    }
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    if (run({
      type: 'entity.deleteRecord',
      label: `Delete variable ${deleteTarget.variableId}`,
      payload: { collection: 'variables', entityId: deleteTarget.variableId, force: true },
    })) {
      setDeleteTarget(null);
    }
  }

  if (!project) return <div className="p-4 text-sm text-muted-foreground">No authoring project loaded.</div>;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Variables</h2>
          <p className="mt-1 text-sm text-muted-foreground">Author typed global state for later dialogue, scene, script, and UI conditions.</p>
        </div>
        <Badge variant="outline">{variables.length} variable{variables.length === 1 ? '' : 's'}</Badge>
      </div>

      <section className="mt-4 rounded border p-3">
        <h3 className="text-sm font-medium">Create variable</h3>
        <div className="mt-3 grid gap-2 lg:grid-cols-[160px_180px_150px_1fr_1fr_auto]">
          <div className="space-y-1"><Label>ID</Label><Input value={createId} onChange={(event) => setCreateId(event.currentTarget.value)} placeholder="has-key" /></div>
          <div className="space-y-1"><Label>Label</Label><Input value={createLabel} onChange={(event) => setCreateLabel(event.currentTarget.value)} placeholder="Has key" /></div>
          <div className="space-y-1"><Label>Type</Label><Select value={createType} onValueChange={(value) => setCreateType(value as VariableType)}>{variableTypeValues.map((type) => <SelectItem key={type} value={type}>{typeLabel(type)}</SelectItem>)}</Select></div>
          {createType === 'enum' ? <div className="space-y-1"><Label>Enum values</Label><Input value={createEnumValues} onChange={(event) => setCreateEnumValues(event.currentTarget.value)} placeholder="idle, active" /></div> : <div />}
          <div className="space-y-1"><Label>Default</Label><Input value={createDefault} onChange={(event) => setCreateDefault(event.currentTarget.value)} /></div>
          <div className="flex items-end"><Button onClick={createVariable}>Create</Button></div>
        </div>
        {message ? <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{message}</div> : null}
      </section>

      <section className="mt-4 min-h-0 rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="p-2">ID</th>
              <th className="p-2">Metadata</th>
              <th className="p-2">Type</th>
              <th className="p-2">Default</th>
              <th className="p-2">Usages</th>
              <th className="p-2">Scope</th>
              <th className="p-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {variables.length === 0 ? <tr><td colSpan={7} className="p-4 text-center text-sm text-muted-foreground">No variables yet.</td></tr> : null}
            {variables.map((variable) => (
              <VariableRow key={variable.id} variableId={variable.id} record={variable.record} usages={variable.usages} onDelete={(variableId, usages) => setDeleteTarget({ variableId, usages })} />
            ))}
          </tbody>
        </table>
      </section>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogPopup>
          <DialogTitle>Delete variable?</DialogTitle>
          <DialogDescription>
            {deleteTarget?.usages.length
              ? `This variable is referenced by ${deleteTarget.usages.length} usage${deleteTarget.usages.length === 1 ? '' : 's'}. Deleting it will leave missing references for validation to report.`
              : 'This variable has no known usages.'}
          </DialogDescription>
          {deleteTarget?.usages.length ? (
            <div className="max-h-40 space-y-1 overflow-auto rounded border p-2 font-mono text-xs text-muted-foreground">
              {deleteTarget.usages.map((usage, index) => <div key={`${usage.path}-${index}`}>{usage.kind}: {usage.sourceCollection}/{usage.sourceId} {usage.path}</div>)}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button size="sm" variant="destructive" onClick={confirmDelete}>Delete Variable</Button>
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
