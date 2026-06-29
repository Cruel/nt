import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lookupRecord(project: unknown, collection: string | undefined, entityId: string | undefined) {
  if (!collection || !entityId || !isRecord(project)) return null;
  const collectionValue = project[collection];
  if (!isRecord(collectionValue)) return null;
  return collectionValue[entityId] ?? null;
}

export function RawJsonEditor({ tab }: WorkbenchEditorProps) {
  const project = useProjectStore((state) => state.document);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const record = lookupRecord(project, tab.resource?.collection, tab.resource?.entityId);
  const formattedRecord = useMemo(() => JSON.stringify(record, null, 2), [record]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(formattedRecord);
  const [error, setError] = useState<string | null>(null);

  function startEditing() {
    setDraft(formattedRecord);
    setError(null);
    setEditing(true);
  }

  function applyDraft() {
    if (!tab.resource?.collection || !tab.resource?.entityId) {
      setError('This tab does not reference an editable record.');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : 'Invalid JSON.');
      return;
    }
    const result = executeCommand({
      type: 'rawJson.replaceRecord',
      label: `Replace ${tab.resource.collection}/${tab.resource.entityId}`,
      payload: {
        collection: tab.resource.collection,
        entityId: tab.resource.entityId,
        record: parsed,
      },
    });
    const failure = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (!result.ok || failure) {
      setError(failure?.message ?? 'Command failed.');
      return;
    }
    setError(null);
    setEditing(false);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{tab.title}</div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">
            {tab.resource?.collection && tab.resource?.entityId
              ? `${tab.resource.collection}/${tab.resource.entityId}`
              : 'No record resource'}
          </div>
        </div>
        <Button size="sm" variant={editing ? 'secondary' : 'outline'} onClick={editing ? applyDraft : startEditing} disabled={record === null}>
          {editing ? 'Apply' : 'Edit JSON'}
        </Button>
        {editing ? (
          <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraft(formattedRecord); setError(null); }}>
            Revert
          </Button>
        ) : null}
        <Badge variant="outline" className="font-mono text-[10px]">
          raw-json
        </Badge>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {record === null ? (
          <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
            <div>
              <div className="font-medium text-foreground">Record not found</div>
              <div className="mt-1 font-mono text-xs">
                {tab.resource?.stableId ?? tab.id}
              </div>
            </div>
          </div>
        ) : editing ? (
          <div className="flex h-full min-h-0 flex-col gap-2">
            {error ? <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</div> : null}
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none rounded border bg-background p-3 font-mono text-[11px] leading-relaxed outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        ) : (
          <pre className="min-h-full rounded bg-muted p-3 font-mono text-[11px] leading-relaxed">
            {formattedRecord}
          </pre>
        )}
      </div>
    </div>
  );
}
