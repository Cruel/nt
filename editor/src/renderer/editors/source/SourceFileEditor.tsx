import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SourceEditor } from '@/components/source/SourceEditor';
import { useProjectSourceStore } from '@/project/project-source-store';
import { sourceFileLanguage } from '../../../shared/project-source-files';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import { useWorkbenchStore } from '@/workbench/workbench-store';

export function SourceFileEditor({ tab }: WorkbenchEditorProps) {
  const files = useProjectSourceStore((state) => state.files);
  const buffersById = useProjectSourceStore((state) => state.buffersById);
  const setText = useProjectSourceStore((state) => state.setText);
  const save = useProjectSourceStore((state) => state.save);
  const acceptDisk = useProjectSourceStore((state) => state.useDisk);
  const setTabDirty = useWorkbenchStore((state) => state.setTabDirty);
  const [saving, setSaving] = useState(false);
  const sourceId = tab.resource?.sourceId ?? null;
  const source = useMemo(
    () => (sourceId ? (files.find((candidate) => candidate.id === sourceId) ?? null) : null),
    [files, sourceId],
  );
  const buffer = sourceId ? buffersById[sourceId] : undefined;

  useEffect(() => {
    setTabDirty(tab.id, Boolean(buffer?.dirty));
    return () => setTabDirty(tab.id, false);
  }, [buffer?.dirty, setTabDirty, tab.id]);

  if (!sourceId || !source)
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Source file is no longer available.
      </div>
    );
  if (!source.text || !buffer)
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        This file is not a text source.
      </div>
    );

  async function saveBuffer(acceptExternalBase = false) {
    setSaving(true);
    try {
      await save(sourceId!, acceptExternalBase);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {source.displayPath}
        </span>
        {buffer.dirty ? <span className="text-[10px] text-muted-foreground">Modified</span> : null}
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          disabled={!buffer.dirty || saving || Boolean(buffer.conflict)}
          onClick={() => void saveBuffer()}
        >
          Save
        </Button>
      </div>
      {buffer.conflict ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">
            {buffer.conflict.externalExists
              ? 'This source changed outside NovelTea while this tab had unsaved edits.'
              : 'This source was deleted outside NovelTea while this tab had unsaved edits.'}
          </span>
          <Button size="sm" variant="outline" className="h-7" onClick={() => acceptDisk(sourceId)}>
            Use Disk
          </Button>
          <Button size="sm" className="h-7" disabled={saving} onClick={() => void saveBuffer(true)}>
            Keep Mine
          </Button>
        </div>
      ) : null}
      <SourceEditor
        value={buffer.text}
        onChange={(text) => setText(sourceId, text)}
        language={sourceFileLanguage(source)}
        className="min-h-0 flex-1"
      />
    </div>
  );
}
