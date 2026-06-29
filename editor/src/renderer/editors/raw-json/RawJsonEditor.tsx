import { Badge } from '@/components/ui/badge';
import { useWorkspaceStore } from '@/stores/workspace-store';
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
  const project = useWorkspaceStore((state) => state.project);
  const record = lookupRecord(project, tab.resource?.collection, tab.resource?.entityId);

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
        ) : (
          <pre className="min-h-full rounded bg-muted p-3 font-mono text-[11px] leading-relaxed">
            {JSON.stringify(record, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
