import type { EditorProjectState } from './project-schema/editor-project-state';
import { EDITOR_LOCAL_STATE_SCHEMA } from './project-workspace/project-workspace-contracts';

function unicodeCodePointOrder(left: string, right: string): number {
  const a = Array.from(left, (value) => value.codePointAt(0)!);
  const b = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

/** Stable, editor-local JSON serialization. This is not a Project authoring
 * codec; only local view/recovery state is supported, and tracked editor
 * organization is never written to the ignored state file. */
function sortLocalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortLocalJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => unicodeCodePointOrder(a, b))
      .map(([key, nested]) => [key, sortLocalJson(nested)]),
  );
}

export function projectWorkspaceLocalStateFile(editorState: EditorProjectState): string {
  const {
    chapters: _chapters,
    tags: _tags,
    recordMetadata: _recordMetadata,
    schema: _schema,
    ...local
  } = editorState;
  return `${JSON.stringify(sortLocalJson({ schema: EDITOR_LOCAL_STATE_SCHEMA, ...local }), null, 2)}\n`;
}
