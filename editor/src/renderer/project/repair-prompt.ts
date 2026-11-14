import type { ToolDiagnostic } from '../../shared/editor-tooling';
import { getJsonAtPointer, hasJsonAtPointer } from './json-pointer';
import { jsonValuesEqual, type JsonValue } from './json-value';
import { candidateFormatRisk } from '../../shared/repair-format-risk';
export { candidateFormatRisk } from '../../shared/repair-format-risk';
export type { CandidateFormatRisk } from '../../shared/repair-format-risk';

export type RepairPromptScope = 'one' | 'all' | 'errors';

export function repairDiagnosticKey(diagnostic: ToolDiagnostic): string {
  return JSON.stringify([
    diagnostic.code,
    diagnostic.severity,
    diagnostic.path,
    diagnostic.message,
    diagnostic.sourcePath,
    diagnostic.line,
    diagnostic.column,
    diagnostic.ownerPaths,
  ]);
}

export function selectedRepairDiagnostics(
  diagnostics: readonly ToolDiagnostic[],
  scope: RepairPromptScope,
  selectedKey?: string,
): ToolDiagnostic[] {
  const current = diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'warning',
  );
  if (scope === 'errors') return current.filter((diagnostic) => diagnostic.severity === 'error');
  if (scope === 'all') return current;
  return current
    .filter((diagnostic) => repairDiagnosticKey(diagnostic) === selectedKey)
    .slice(0, 1);
}

function ownerOf(pointer: string): string {
  const [, collection, id] = pointer.split('/');
  return collection && id ? '/' + collection + '/' + id : pointer;
}

function projectRelativeSourcePath(value: string): string | null {
  const candidate = (
    value.startsWith('project:/') ? value.slice('project:/'.length) : value
  ).replaceAll('\\', '/');
  if (!candidate || candidate.startsWith('/') || /^[A-Za-z]:/u.test(candidate)) return null;
  if (candidate.split('/').some((segment) => !segment || segment === '.' || segment === '..'))
    return null;
  return candidate;
}

function valueLabel(value: JsonValue | null, exists: boolean): string {
  if (!exists) return '(absent)';
  const json = JSON.stringify(value);
  return json.length <= 160 ? json : '(value too long to inline)';
}

/** A local difference is useful context, not proof of which revision caused a diagnostic. */
function workingContext(
  diagnostic: ToolDiagnostic,
  saved: JsonValue | null | undefined,
  working: JsonValue | null | undefined,
): string | null {
  if (saved == null || working == null) return null;
  const pointer = diagnostic.path;
  if (pointer.startsWith('/') && pointer !== '/') {
    const diskPresent = hasJsonAtPointer(saved, pointer);
    const workingPresent = hasJsonAtPointer(working, pointer);
    const diskValue = diskPresent ? getJsonAtPointer(saved, pointer) : null;
    const workingValue = workingPresent ? getJsonAtPointer(working, pointer) : null;
    if (
      diskPresent !== workingPresent ||
      (diskPresent && workingPresent && !jsonValuesEqual(diskValue!, workingValue!))
    )
      return (
        'Saved ' +
        valueLabel(diskValue, diskPresent) +
        '; editor working ' +
        valueLabel(workingValue, workingPresent) +
        '.'
      );
  }
  const owner = ownerOf(diagnostic.ownerPaths?.[0] ?? pointer);
  if (!owner.startsWith('/')) return null;
  const diskPresent = hasJsonAtPointer(saved, owner);
  const workingPresent = hasJsonAtPointer(working, owner);
  if (
    diskPresent !== workingPresent ||
    (diskPresent &&
      workingPresent &&
      !jsonValuesEqual(getJsonAtPointer(saved, owner), getJsonAtPointer(working, owner)))
  )
    return 'Other unsaved edits exist in ' + owner + '; they may not cause this issue.';
  return null;
}

export interface RepairPromptInput {
  root: string;
  kind: 'candidate' | 'active';
  scope: RepairPromptScope;
  diagnostics: readonly ToolDiagnostic[];
  selectedKey?: string;
  recognition?: 'strong' | 'weak';
  manifest?: string;
  /** Last observed saved baseline and current native editing view. */
  savedDocument?: JsonValue | null;
  workingDocument?: JsonValue | null;
}

export function repairDiagnosticFingerprint(diagnostics: readonly ToolDiagnostic[]): string {
  return JSON.stringify(diagnostics.map(repairDiagnosticKey).sort());
}

export function buildRepairPrompt(input: RepairPromptInput): string | null {
  const selected = selectedRepairDiagnostics(input.diagnostics, input.scope, input.selectedKey);
  if (!selected.length) return null;

  const scope =
    input.scope === 'one'
      ? 'selected issue only'
      : input.scope === 'errors'
        ? 'all errors'
        : 'all errors and warnings';
  const lines = [
    'Fix these NovelTea Project issues without changing unrelated data.',
    'Project root: ' + input.root,
    'Scope: ' + scope,
    '',
    ...selected.map((diagnostic, index) => {
      const source = diagnostic.sourcePath
        ? projectRelativeSourcePath(diagnostic.sourcePath)
        : null;
      const location = source
        ? ' (' +
          source +
          (diagnostic.line
            ? ':' + diagnostic.line + (diagnostic.column ? ':' + diagnostic.column : '')
            : '') +
          ')'
        : '';
      const workingLocation =
        input.kind === 'active' && source
          ? '\n   Unsaved working-file path (when present in the working-source manifest): .noveltea/editor/working/files/' +
            source
          : '';
      const context =
        input.kind === 'active'
          ? workingContext(diagnostic, input.savedDocument, input.workingDocument)
          : null;
      return (
        index +
        1 +
        '. [' +
        diagnostic.severity +
        '] ' +
        (diagnostic.code ?? 'issue') +
        ' at ' +
        diagnostic.path +
        location +
        ': ' +
        diagnostic.message +
        workingLocation +
        (context ? '\n   ' + context : '')
      );
    }),
    '',
    'Read, search, and modify files only inside this Project root (including symlink targets). Ask before accessing anything outside it.',
    'Follow the Project AGENTS.md for NovelTea CLI usage.',
  ];
  if (input.kind === 'active')
    lines.push(
      'Editor diagnostics may come from unsaved working state. First read .noveltea/editor/working/manifest.json. For a listed dirty source, edit only its matching .noveltea/editor/working/files/<physical-project-relative-path> (or the declared pending/deletion artifact), not the tracked saved source. For a clean source without a working projection, ordinary tracked-file edits remain appropriate. The editor must reconcile agent edits before Save. Never edit .noveltea/editor/native-dirty-state.json, .noveltea/editor/state.json, working/manifest.json, or working/baselines/. If the required unsaved source is absent or cannot be represented, report the blocker; do not invent an editor API.',
    );
  if (input.recognition === 'weak')
    lines.push('Project identification is uncertain: do not modify source without user approval.');
  if (candidateFormatRisk(input.manifest) === 'newer')
    lines.push('Newer schema version: do not convert or downgrade without explicit user approval.');
  return lines.join('\n');
}
