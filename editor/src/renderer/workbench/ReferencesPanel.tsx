import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useEntityUsagesStore, usageSourceIsRecord } from '@/project/entity-usages-store';
import { referenceTargetLabel, referenceUsageSummary } from '@/project/entity-operations';
import type { AssetNode } from '@/stores/workspace-store';
import { buildDefaultRecordTab } from './editor-registry';
import { useWorkbenchStore } from './workbench-store';

export function nodeForUsage(collection: string, entityId: string): AssetNode {
  return {
    id: `${collection}:${entityId}`,
    label: entityId,
    type:
      collection === 'variables' ? 'variable'
        : collection === 'assets' ? 'asset'
          : collection === 'shaders' ? 'shader'
            : collection === 'materials' ? 'material'
              : collection === 'layouts' ? 'layout'
                : collection === 'characters' ? 'character'
                  : 'folder',
    collection,
    entityId,
  };
}

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
        <span className="text-muted-foreground">
          {result.usageRows.length === 0 ? referenceUsageSummary([]) : `${result.usageRows.length} usage${result.usageRows.length === 1 ? '' : 's'} found.`}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={clearUsages}>
          Clear
        </Button>
      </div>
      {result.searchResults?.length ? (
        <div className="space-y-2">
          {result.searchResults.map((searchResult) => (
            <div key={searchResult.document.id} className="rounded border p-2">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">usage</Badge>
                <span className="font-mono text-muted-foreground">
                  {searchResult.document.collection}/{searchResult.document.entityId}
                </span>
                {searchResult.document.collection && searchResult.document.entityId ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-6 px-2 text-[11px]"
                    onClick={() => {
                      const tab = buildDefaultRecordTab(nodeForUsage(searchResult.document.collection!, searchResult.document.entityId!));
                      if (tab) openTab(tab);
                    }}
                  >
                    Open source
                  </Button>
                ) : null}
              </div>
              <div className="mt-1 space-y-1">
                {searchResult.matches.filter((match) => match.mode === 'reference').map((match, index) => (
                  <div key={`${match.path}-${index}`} className="truncate font-mono text-[10px] text-muted-foreground">
                    {match.fieldLabel}: {match.path}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : result.usageRows.length === 0 ? (
        <p className="rounded border p-3 text-muted-foreground">No references point to this record.</p>
      ) : (
        <div className="space-y-2">
          {result.usageRows.map((row, index) => {
            const usage = row.usage;
            const sourceCollection = usage.sourceCollection;
            const sourceId = usage.sourceId;
            return <div key={`${usage.path}-${index}`} className="rounded border p-2">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{row.kind === 'asset-alias' ? 'asset-alias' : usage.kind}</Badge>
                <span className="font-mono text-muted-foreground">
                  {sourceCollection}/{sourceId}
                </span>
                {usageSourceIsRecord(sourceCollection) ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-6 px-2 text-[11px]"
                    onClick={() => {
                      const tab = buildDefaultRecordTab(nodeForUsage(sourceCollection, sourceId));
                      if (tab) openTab(tab);
                    }}
                  >
                    Open source
                  </Button>
                ) : null}
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                {row.kind === 'asset-alias' ? `${row.usage.alias}: ${row.usage.path}` : usage.path}
              </div>
            </div>;
          })}
        </div>
      )}
    </div>
  );
}
