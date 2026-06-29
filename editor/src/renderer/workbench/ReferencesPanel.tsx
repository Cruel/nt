import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useEntityUsagesStore, usageSourceIsRecord } from '@/project/entity-usages-store';
import { referenceTargetLabel, referenceUsageSummary } from '@/project/entity-operations';
import { useWorkbenchStore } from './workbench-store';
import { buildRawJsonTabForRecord } from './editor-registry';

export function ReferencesPanel() {
  const result = useEntityUsagesStore((state) => state.result);
  const clearUsages = useEntityUsagesStore((state) => state.clearUsages);
  const openTab = useWorkbenchStore((state) => state.openTab);

  if (!result) {
    return <p className="p-3 text-xs text-muted-foreground">No Find Usages result yet.</p>;
  }

  return (
    <div className="space-y-3 p-3 text-xs">
      <div className="flex items-center gap-2">
        <Badge variant="outline">References</Badge>
        <span className="font-mono">{referenceTargetLabel(result.target)}</span>
        <span className="text-muted-foreground">{referenceUsageSummary(result.usages)}</span>
        <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={clearUsages}>
          Clear
        </Button>
      </div>
      {result.usages.length === 0 ? (
        <p className="rounded border p-3 text-muted-foreground">No references point to this record.</p>
      ) : (
        <div className="space-y-2">
          {result.usages.map((usage, index) => (
            <div key={`${usage.path}-${index}`} className="rounded border p-2">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{usage.kind}</Badge>
                <span className="font-mono text-muted-foreground">
                  {usage.sourceCollection}/{usage.sourceId}
                </span>
                {usageSourceIsRecord(usage.sourceCollection) ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-6 px-2 text-[11px]"
                    onClick={() =>
                      openTab(
                        buildRawJsonTabForRecord(
                          usage.sourceCollection,
                          usage.sourceId,
                          usage.sourceId,
                        ),
                      )
                    }
                  >
                    Open source
                  </Button>
                ) : null}
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                {usage.path}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
