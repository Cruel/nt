import { useMemo } from 'react';
import { SourceEditor } from '@/components/source/SourceEditor';
import { useProjectSourceStore } from '@/project/project-source-store';
import { sourceFileLanguage } from '../../../shared/project-source-files';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';

export function SourceFileEditor({ tab }: WorkbenchEditorProps) {
  const files = useProjectSourceStore((state) => state.files);
  const textById = useProjectSourceStore((state) => state.textById);
  const sourceId = tab.resource?.sourceId ?? null;
  const source = useMemo(
    () => (sourceId ? (files.find((candidate) => candidate.id === sourceId) ?? null) : null),
    [files, sourceId],
  );

  if (!sourceId || !source)
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Source file is no longer available.
      </div>
    );
  if (!source.text)
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        This file is not a text source.
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b px-3 py-1.5 font-mono text-xs text-muted-foreground">
        {source.displayPath}
      </div>
      <SourceEditor
        value={textById[source.id] ?? ''}
        language={sourceFileLanguage(source)}
        readOnly
        className="min-h-0 flex-1"
      />
    </div>
  );
}
