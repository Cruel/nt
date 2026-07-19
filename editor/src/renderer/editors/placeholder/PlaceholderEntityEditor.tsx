import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useProjectStore } from '@/project/project-store';
import {
  authoringCollectionMetadata,
  isAuthoringCollectionKey,
} from '../../../shared/project-schema/authoring-collections';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';

export function PlaceholderEntityEditor({ tab }: WorkbenchEditorProps) {
  const projectDocument = useProjectStore((state) => state.document);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const collection = isAuthoringCollectionKey(tab.resource?.collection)
    ? tab.resource.collection
    : null;
  const entityId = tab.resource?.entityId ?? null;
  const metadata = collection ? authoringCollectionMetadata[collection] : null;
  const record = project && collection && entityId ? project[collection][entityId] : null;

  return (
    <div className="h-full overflow-auto bg-background p-6">
      <Card className="mx-auto max-w-2xl">
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>{record?.label ?? tab.title}</CardTitle>
            <Badge variant="outline">Placeholder</Badge>
          </div>
          <CardDescription>
            {metadata
              ? `${metadata.singularLabel} editing is not implemented yet. The wizard created the record so references and organization can be built now.`
              : 'This editor is a placeholder for a pending editing surface.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid grid-cols-[6rem_1fr] gap-2">
            <div className="text-muted-foreground">Type</div>
            <div>{metadata?.singularLabel ?? 'Unknown'}</div>
            <div className="text-muted-foreground">ID</div>
            <div className="font-mono text-xs">{entityId ?? 'unknown'}</div>
          </div>
          {record?.description ? (
            <p className="text-muted-foreground">{record.description}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Future work should replace this with a typed editor and schema-specific wizard options.
            For now, use metadata, tags, chapters, and references to organize these records.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
