import type { DraftDirtyEntry } from '../workbench/draft-dirty-store';

/** An AI prompt must not pretend that native source publication included an
 * unsent renderer draft. The only safe choices are to acknowledge it through
 * native staging, serialize it as pending, or report it as unprojectable. */
export function assertNoUnprojectedRendererDrafts(
  entriesByKey: Readonly<Record<string, DraftDirtyEntry>>,
): void {
  const missing = Object.values(entriesByKey).filter(
    (entry) => entry.dirty && entry.payload !== undefined,
  );
  if (!missing.length) return;
  throw new Error(
    `${missing.length} unsaved editor draft(s) cannot yet be represented as agent-editable working sources. Apply or discard them before Copy/Run/Fix; the original drafts are preserved.`,
  );
}
