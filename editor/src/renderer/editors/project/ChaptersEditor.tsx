import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCommandStore } from '@/commands/command-store';
import { projectEdits } from '@/commands/project-editing';
import { ProjectFieldInput } from '@/commands/use-project-field';
import { buildJsonPointer } from '@/project/json-pointer';
import type { CommandRequest } from '@/commands/command-types';
import { SAVE_UNIT_IDS } from '@/project/save-unit-registry';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  authoringCollectionMetadata,
  isAuthoringCollectionKey,
} from '../../../shared/project-schema/authoring-collections';
import { isAuthoringProjectView } from '../../../shared/project-schema/authoring-project-view';
import { editorProjectStateFromProject } from '@/workbench/project-editor-state';
import { recordTargetKey } from '@/workspace/project-explorer-store';
import {
  useWorkbenchEditorTabState,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';

function commandSucceeded(
  result: ReturnType<ReturnType<typeof useCommandStore.getState>['executeCommand']>,
) {
  return result.ok && !result.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

const CHAPTERS_TAB_STATE_SCHEMA = 'noveltea.editor.chapters-tab-state';

function ChapterFields({
  id,
  label,
  color,
  tabId,
}: {
  id: string;
  label: string;
  color: string | null;
  tabId: string;
}) {
  const saveUnitId = SAVE_UNIT_IDS.projectChapters;
  return (
    <>
      <div className="min-w-0">
        <ProjectFieldInput
          aria-label={`Chapter ${id} label`}
          tabId={tabId}
          saveUnitId={saveUnitId}
          path={buildJsonPointer(['editor', 'chapters', 'records', id, 'label'])}
          value={label}
          label={`Rename chapter ${id}`}
          buildCommand={(nextLabel) => ({
            type: 'project.renameChapter',
            label: `Rename chapter ${id}`,
            payload: { chapterId: id, label: nextLabel },
            originSaveUnitId: saveUnitId,
            persistencePolicy: 'manual-save',
          })}
        />
        <div className="mt-1 font-mono text-[10px] text-muted-foreground">{id}</div>
      </div>
      <ProjectFieldInput
        aria-label={`Chapter ${id} color`}
        tabId={tabId}
        saveUnitId={saveUnitId}
        path={buildJsonPointer(['editor', 'chapters', 'records', id, 'color'])}
        value={color ?? ''}
        label={`Set chapter color ${id}`}
        buildCommand={(nextColor) => ({
          type: 'project.setChapterColor',
          label: `Set chapter color ${id}`,
          payload: { chapterId: id, color: nextColor.trim() || null },
          originSaveUnitId: saveUnitId,
          persistencePolicy: 'manual-save',
        })}
      />
    </>
  );
}

export function ChaptersEditor({ tab }: WorkbenchEditorProps) {
  const document = useProjectStore((state) => state.document);
  const executeCommand = projectEdits.execute;
  const project = isAuthoringProjectView(document) ? document : null;
  const editorState = useMemo(
    () => (project ? editorProjectStateFromProject(project) : null),
    [project],
  );
  const chapters = editorState?.chapters ?? { records: {}, assignments: {} };
  const [chapterId, setChapterId] = useState('');
  const [label, setLabel] = useState('');
  const [color, setColor] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const collection = isAuthoringCollectionKey(tab.resource?.collection)
    ? tab.resource.collection
    : null;
  const entityId = tab.resource?.entityId ?? null;
  const targetRecord =
    project && collection && entityId ? (project[collection][entityId] ?? null) : null;
  const assignmentKey = collection && entityId ? recordTargetKey(collection, entityId) : null;
  const chapterEntries = useMemo(
    () =>
      Object.entries(chapters.records).sort(([, left], [, right]) =>
        (left.label || left.id).localeCompare(right.label || right.id),
      ),
    [chapters.records],
  );

  useWorkbenchEditorTabState(
    tab.id,
    useMemo(
      () => ({
        schema: CHAPTERS_TAB_STATE_SCHEMA,
        captureTabState: (): WorkbenchTabStatePayload => ({
          schema: CHAPTERS_TAB_STATE_SCHEMA,
          payload: { chapterId, label, color, selected: [...selected] },
        }),
        restoreTabState: (state: WorkbenchTabStatePayload) => {
          if (state.schema !== CHAPTERS_TAB_STATE_SCHEMA) return;
          const payload = state.payload;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
          const values = payload as Record<string, unknown>;
          if (typeof values.chapterId === 'string') setChapterId(values.chapterId);
          if (typeof values.label === 'string') setLabel(values.label);
          if (typeof values.color === 'string') setColor(values.color);
          if (
            Array.isArray(values.selected) &&
            values.selected.every((id: unknown) => typeof id === 'string')
          )
            setSelected(new Set(values.selected as string[]));
        },
      }),
      [chapterId, color, label, selected],
    ),
  );

  useEffect(() => {
    setMessage(null);
    setSelected(new Set(assignmentKey ? (chapters.assignments[assignmentKey] ?? []) : []));
  }, [assignmentKey, chapters.assignments]);

  if (!project)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Open an authoring project to manage chapters.
      </div>
    );

  async function run(command: Omit<CommandRequest, 'originSaveUnitId' | 'persistencePolicy'>) {
    const result = await executeCommand({
      ...command,
      originSaveUnitId: SAVE_UNIT_IDS.projectChapters,
      persistencePolicy: 'manual-save',
    });
    const failure = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    setMessage(failure?.message ?? null);
    return commandSucceeded(result);
  }

  async function createChapter() {
    if (
      await run({
        type: 'project.createChapter',
        label: 'Create chapter',
        payload: { chapterId: chapterId.trim(), label: label.trim(), color: color.trim() || null },
      })
    ) {
      setChapterId('');
      setLabel('');
      setColor('');
    }
  }

  function deleteChapter(id: string) {
    void run({
      type: 'project.deleteChapter',
      label: `Delete chapter ${id}`,
      payload: { chapterId: id },
    });
  }

  function applyAssignment() {
    if (!collection || !entityId) return;
    void run({
      type: 'project.assignChapters',
      label: `Assign chapters to ${collection}/${entityId}`,
      payload: { collection, entityId, chapterIds: [...selected] },
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4">
      <div className="mb-4 flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Chapters</h2>
          <p className="text-xs text-muted-foreground">
            Create, rename, color, delete, and assign editor-only chapters.
          </p>
        </div>
      </div>
      {message ? (
        <div className="mb-4 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {message}
        </div>
      ) : null}
      {targetRecord && collection && entityId ? (
        <section className="mb-4 rounded border p-3">
          <div className="mb-2 text-sm font-medium">
            Assign chapters to {targetRecord.label || entityId}
          </div>
          <div className="mb-3 text-xs text-muted-foreground">
            {authoringCollectionMetadata[collection].singularLabel} ·{' '}
            <span className="font-mono">
              {collection}/{entityId}
            </span>
          </div>
          <div className="max-h-48 space-y-2 overflow-auto">
            {chapterEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground">No chapters exist yet.</p>
            ) : (
              chapterEntries.map(([id, chapter]) => (
                <label key={id} className="flex items-center gap-2 rounded border p-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(id)}
                    onChange={(event) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.currentTarget.checked) next.add(id);
                        else next.delete(id);
                        return next;
                      })
                    }
                  />
                  <span
                    className="h-2.5 w-2.5 rounded-full border"
                    style={{ backgroundColor: chapter.color ?? 'transparent' }}
                  />
                  <span>{chapter.label}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{id}</span>
                </label>
              ))
            )}
          </div>
          <div className="mt-3 flex justify-end">
            <Button size="sm" onClick={applyAssignment}>
              Apply Assignment
            </Button>
          </div>
        </section>
      ) : null}
      <section className="rounded border p-3">
        <div className="mb-3 text-sm font-medium">Chapter registry</div>
        <div className="grid gap-2 @3xl:grid-cols-[1fr_1fr_8rem_auto]">
          <Input
            value={chapterId}
            onChange={(event) => setChapterId(event.currentTarget.value)}
            placeholder="chapter-id"
          />
          <Input
            value={label}
            onChange={(event) => setLabel(event.currentTarget.value)}
            placeholder="Chapter label"
          />
          <Input
            value={color}
            onChange={(event) => setColor(event.currentTarget.value)}
            placeholder="#8b5cf6"
          />
          <Button size="sm" onClick={createChapter}>
            <Plus className="h-3.5 w-3.5" /> Create
          </Button>
        </div>
        <div className="mt-4 max-h-[52vh] space-y-2 overflow-auto">
          {chapterEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No chapters exist yet.</p>
          ) : (
            chapterEntries.map(([id, chapter]) => (
              <div
                key={id}
                className="grid items-center gap-2 rounded border p-2 @3xl:grid-cols-[1fr_8rem_auto]"
              >
                <ChapterFields
                  id={id}
                  label={chapter.label}
                  color={chapter.color ?? null}
                  tabId={tab.id}
                />
                <Button size="sm" variant="destructive" onClick={() => deleteChapter(id)}>
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </Button>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
