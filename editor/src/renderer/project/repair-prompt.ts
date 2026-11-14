import type { ToolDiagnostic } from '../../shared/editor-tooling';
import { getJsonAtPointer, hasJsonAtPointer } from './json-pointer';
import { jsonValuesEqual, type JsonValue } from './json-value';
import { candidateFormatRisk } from '../../shared/repair-format-risk';
import type { WorkingSourceRepresentations } from '../../shared/editor-tooling';
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

/** Ownership difference is context, never causal attribution for a diagnostic. */
export function repairDiagnosticOwnerIsDirty(
  diagnostic: ToolDiagnostic,
  saved: JsonValue | null | undefined,
  working: JsonValue | null | undefined,
): boolean {
  if (saved == null || working == null) return false;
  const sourceOwner = diagnostic.sourcePath?.match(/^records\/([^/]+)\/([^/]+)\.yaml$/);
  const owner = sourceOwner
    ? `/${sourceOwner[1]}/${sourceOwner[2]}`
    : ownerOf(diagnostic.ownerPaths?.[0] ?? diagnostic.path);
  if (!owner.startsWith('/') || owner === '/') return false;
  const diskPresent = hasJsonAtPointer(saved, owner);
  const workingPresent = hasJsonAtPointer(working, owner);
  return (
    diskPresent !== workingPresent ||
    (diskPresent &&
      workingPresent &&
      !jsonValuesEqual(getJsonAtPointer(saved, owner), getJsonAtPointer(working, owner)))
  );
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
  /** Returned only after main has durably published this Project's native working sources. */
  workingSources?: WorkingSourceRepresentations;
}

export function repairDiagnosticFingerprint(diagnostics: readonly ToolDiagnostic[]): string {
  return JSON.stringify(diagnostics.map(repairDiagnosticKey).sort());
}

/** Diagnostic messages may contain Markdown fences or newlines. Keep the entire
 * numbered diagnostic block intact when pasted into an agent conversation. */
function fencedDiagnostics(content: string): string[] {
  const longestBacktickRun = Math.max(0, ...(content.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return [fence + 'text', content, fence];
}

function indentDiagnostic(value: string): string {
  return value.replace(/\r\n?|\n/gu, '\n   ');
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
  const targets: string[] = [];
  let needsWorkingValidation = false;
  const issues = selected.map((diagnostic, index) => {
    const source = diagnostic.sourcePath ? projectRelativeSourcePath(diagnostic.sourcePath) : null;
    const location = source
      ? source +
        (diagnostic.line
          ? ':' + diagnostic.line + (diagnostic.column ? ':' + diagnostic.column : '')
          : '')
      : '';
    const representation =
      input.kind === 'active' && source ? input.workingSources?.[source] : undefined;
    const missingWorkingOwner =
      input.kind === 'active' &&
      source &&
      !representation &&
      (diagnostic.observedAgainst === 'working-file' ||
        repairDiagnosticOwnerIsDirty(diagnostic, input.savedDocument, input.workingDocument));
    const target =
      representation === 'file'
        ? 'Edit unsaved working file: .noveltea/editor/working/files/' +
          source +
          ' (NOT the saved ' +
          source +
          ').'
        : representation === 'deleted'
          ? 'Unsaved deletion marker: .noveltea/editor/working/deletions/' +
            source +
            '.delete.json; do not recreate the saved source.'
          : representation === 'pending-only'
            ? 'Pending editor input: .noveltea/editor/working/pending/' +
              source +
              '.json; ask the user to finish the field rather than editing recovery state.'
            : missingWorkingOwner
              ? 'This unsaved owner has no published working file. Report the missing projection; do not edit the valid saved source.'
              : source
                ? 'Saved source: ' + source
                : '';
    if (target) targets.push(`${index + 1}. ${target}`);
    if (representation || missingWorkingOwner) needsWorkingValidation = true;
    const context =
      input.kind === 'active'
        ? workingContext(diagnostic, input.savedDocument, input.workingDocument)
        : null;
    return [
      `${index + 1}. [${diagnostic.severity}] ${indentDiagnostic(diagnostic.code ?? 'issue')}`,
      `   Path: ${indentDiagnostic(diagnostic.path)}`,
      ...(source ? [`   Source: ${indentDiagnostic(location)}`] : []),
      `   Message: ${indentDiagnostic(diagnostic.message)}`,
      ...(context ? [`   ${indentDiagnostic(context)}`] : []),
    ].join('\n');
  });
  const lines = [
    'Fix only the following NovelTea Project issue(s).',
    'Project root: ' + input.root,
    'Scope: ' + scope,
    '',
    'Issues:',
    ...fencedDiagnostics(issues.join('\n\n')),
    ...(targets.length ? ['', 'Repair targets:', ...targets] : []),
    '',
    'Read, search, and modify files only inside this Project root (including resolved symlink targets). Ask before accessing anything outside it.',
    'Follow the Project AGENTS.md for NovelTea CLI usage.',
  ];
  if (needsWorkingValidation)
    lines.push(
      'Run `noveltea validate --working` from the Project root to verify unsaved changes; this does not Save the Project. Ordinary `noveltea validate` checks saved files only.',
    );
  else if (input.kind === 'active')
    lines.push('Run `noveltea validate` from the Project root to verify saved-source repairs.');
  else
    lines.push(
      'After repairing saved sources, run `noveltea validate` from the Project root if the Project can be admitted.',
    );
  if (input.kind === 'active')
    lines.push(
      'Do not edit editor-owned recovery, manifest, or baseline files. If a necessary unsaved working source is unavailable, report it instead of modifying the saved source.',
    );
  if (input.recognition === 'weak')
    lines.push('Project identification is uncertain: do not modify source without user approval.');
  if (candidateFormatRisk(input.manifest) === 'newer')
    lines.push('Newer schema version: do not convert or downgrade without explicit user approval.');
  return lines.join('\n');
}
