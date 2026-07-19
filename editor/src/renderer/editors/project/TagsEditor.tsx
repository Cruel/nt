import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TagBadge } from '@/components/tags/TagBadge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { SAVE_UNIT_IDS } from '@/project/save-unit-registry';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  authoringCollectionMetadata,
  authoringCollectionKeys,
} from '../../../shared/project-schema/authoring-collections';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import {
  collectProjectTags,
  TAG_COLOR_POOL,
  type ProjectTagSummary,
  type TagColor,
} from '../../../shared/project-schema/authoring-tags';

function escapeJsonPointerToken(value: string) {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function collectionSummary(tag: ProjectTagSummary) {
  return authoringCollectionKeys
    .flatMap((collection) => {
      const count = tag.collections[collection] ?? 0;
      return count > 0 ? [`${authoringCollectionMetadata[collection].label}: ${count}`] : [];
    })
    .join(' · ');
}

export function TagsEditor(_props: WorkbenchEditorProps) {
  const document = useProjectStore((state) => state.document);
  const executeCommand = useCommandStore((state) => state.executeCommand);
  const project = isAuthoringProject(document) ? document : null;
  const tags = project
    ? collectProjectTags(project).sort((left, right) => left.name.localeCompare(right.name))
    : [];
  const registryKeys = new Set(Object.keys(project?.editor.tags?.records ?? {}));

  if (!project)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Open an authoring project to manage tags.
      </div>
    );

  function setColor(tag: ProjectTagSummary, color: TagColor) {
    executeCommand({
      type: 'project.setTagColor',
      label: `Set tag color ${tag.name}`,
      payload: { tag: tag.name, color },
      originSaveUnitId: SAVE_UNIT_IDS.projectTags,
      persistencePolicy: 'manual-save',
    });
  }

  function deleteUnusedTag(tag: ProjectTagSummary) {
    if (tag.count > 0 || !registryKeys.has(tag.key)) return;
    executeCommand({
      type: 'project.removeAtPath',
      label: `Delete unused tag ${tag.name}`,
      payload: { path: `/editor/tags/records/${escapeJsonPointerToken(tag.key)}` },
      originSaveUnitId: SAVE_UNIT_IDS.projectTags,
      persistencePolicy: 'manual-save',
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4">
      <div className="mb-4 min-w-0">
        <h2 className="text-lg font-semibold">Tags</h2>
        <p className="text-xs text-muted-foreground">
          Review tag usage, change tag colors, and remove unused registry entries.
        </p>
      </div>
      <div className="rounded border">
        <div className="grid grid-cols-[minmax(12rem,1fr)_6rem_minmax(12rem,1fr)_9rem_6rem] gap-2 border-b px-3 py-2 text-xs font-medium text-muted-foreground">
          <div>Tag</div>
          <div>Uses</div>
          <div>Collections</div>
          <div>Color</div>
          <div />
        </div>
        <div className="max-h-[70vh] overflow-auto">
          {tags.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No tags exist yet.</div>
          ) : (
            tags.map((tag) => {
              const unusedRegistryEntry = tag.count === 0 && registryKeys.has(tag.key);
              return (
                <div
                  key={tag.key}
                  className="grid grid-cols-[minmax(12rem,1fr)_6rem_minmax(12rem,1fr)_9rem_6rem] items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0"
                >
                  <div className="min-w-0">
                    <TagBadge name={tag.name} color={tag.color} />
                  </div>
                  <div className="font-mono text-xs">{tag.count}</div>
                  <div
                    className="truncate text-xs text-muted-foreground"
                    title={collectionSummary(tag)}
                  >
                    {collectionSummary(tag) || 'Unused registry tag'}
                  </div>
                  <Select
                    value={tag.color}
                    onValueChange={(value) => setColor(tag, value as TagColor)}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TAG_COLOR_POOL.map((color) => (
                        <SelectItem key={color} value={color}>
                          {color.replace('tag-', '')}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={!unusedRegistryEntry}
                    onClick={() => deleteUnusedTag(tag)}
                    title={
                      unusedRegistryEntry
                        ? 'Delete unused registry tag'
                        : 'Only unused registry tags can be deleted here'
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
