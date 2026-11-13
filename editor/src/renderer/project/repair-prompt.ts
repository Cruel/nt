import type { AuthoringDependencyGraphSnapshot } from '../../shared/authoring-dependency-contracts';
import type { ToolDiagnostic } from '../../shared/editor-tooling';
import { isAuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';

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

function sourceFileForPath(pointer: string): string | null {
  const segments = pointer
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  const [collection, id] = segments;
  if (
    ['project', 'settings', 'entrypoint', 'export', 'interactableInstances'].includes(
      collection ?? '',
    )
  )
    return 'project.yaml';
  if (collection === 'editor') return 'editor.yaml';
  if (collection === 'traits') return 'traits.yaml';
  if (collection && id && isAuthoringCollectionKey(collection) && /^[A-Za-z0-9_-]+$/u.test(id))
    return collection === 'layouts'
      ? `records/layouts/${id}/layout.yaml`
      : `records/${collection}/${id}.yaml`;
  return null;
}

function ownerOf(pointer: string): string {
  const [, collection, id] = pointer.split('/');
  return collection && id && isAuthoringCollectionKey(collection)
    ? `/${collection}/${id}`
    : pointer;
}

function dependencyContext(
  selected: readonly ToolDiagnostic[],
  graph?: AuthoringDependencyGraphSnapshot | null,
): string[] {
  if (!graph) return [];
  const edges = [...graph.graph.edgesById.values()];
  const visited = new Set<string>();
  const roots = selected.flatMap((diagnostic) =>
    diagnostic.ownerPaths?.length ? diagnostic.ownerPaths : [diagnostic.path],
  );
  const queue = roots.map(ownerOf);
  for (const root of queue) visited.add(root);
  const context = new Set<string>();
  // Only traverse known native graph references, never guess dependencies from names.
  while (queue.length > 0 && visited.size < 64) {
    const current = queue.shift()!;
    for (const edge of edges) {
      if (ownerOf(edge.sourcePath) !== current) continue;
      const dependency = ownerOf(edge.targetPath);
      if (visited.has(dependency)) continue;
      context.add(dependency);
      visited.add(dependency);
      queue.push(dependency);
    }
  }
  return [...context].sort();
}

export type CandidateFormatRisk = 'current' | 'older' | 'newer' | 'unknown';

export function candidateFormatRisk(manifest: string | undefined): CandidateFormatRisk {
  if (manifest === undefined) return 'unknown';
  // An unambiguous top-level scalar is still readable when other YAML is broken.
  const versions = [...manifest.matchAll(/^schemaVersion:\s*([0-9]+)\s*(?:#.*)?$/gmu)];
  if (versions.length !== 1) return 'unknown';
  const version = Number(versions[0]![1]);
  if (!Number.isSafeInteger(version)) return 'unknown';
  if (version > 1) return 'newer';
  if (version < 1) return 'older';
  return 'current';
}

export interface RepairPromptInput {
  root: string;
  kind: 'candidate' | 'active';
  scope: RepairPromptScope;
  diagnostics: readonly ToolDiagnostic[];
  selectedKey?: string;
  recognition?: 'strong' | 'weak';
  manifest?: string;
  graph?: AuthoringDependencyGraphSnapshot | null;
}

export function repairDiagnosticFingerprint(diagnostics: readonly ToolDiagnostic[]): string {
  return JSON.stringify(diagnostics.map(repairDiagnosticKey).sort());
}

export function buildRepairPrompt(input: RepairPromptInput): string | null {
  const selected = selectedRepairDiagnostics(input.diagnostics, input.scope, input.selectedKey);
  if (!selected.length) return null;

  const filePaths = new Set<string>();
  for (const diagnostic of selected) {
    if (diagnostic.sourcePath) filePaths.add(diagnostic.sourcePath);
    for (const pointer of diagnostic.ownerPaths?.length
      ? diagnostic.ownerPaths
      : [diagnostic.path]) {
      const file = sourceFileForPath(pointer);
      if (file) filePaths.add(file);
    }
  }
  const dependencies = dependencyContext(selected, input.graph);
  const affected = [...filePaths].sort();
  const lines = [
    'Repair the selected NovelTea Project diagnostics, preserving existing authored data.',
    `Project ${input.kind === 'candidate' ? 'Candidate' : 'root'}: ${input.root}`,
    `Scope: ${input.scope === 'one' ? 'only the selected diagnostic and necessary dependencies' : input.scope === 'errors' ? 'all current errors (exclude warnings)' : 'all current errors and warnings'}`,
    '',
    'Selected diagnostics:',
    ...selected.map((d, index) => {
      const location = d.sourcePath
        ? `; source ${d.sourcePath}${d.line ? `:${d.line}${d.column ? `:${d.column}` : ''}` : ''}`
        : '';
      return `${index + 1}. [${d.severity}] ${d.code ?? 'diagnostic'} at ${d.path}${location}: ${d.message}${d.ownerPaths?.length ? `; owners: ${d.ownerPaths.join(', ')}` : ''}`;
    }),
    '',
    'Affected source files (inspect; change only what is required by the selected diagnostics):',
    ...(affected.length
      ? affected.map((file) => `- ${file}`)
      : ['- Resolve source ownership from the diagnostics and Project format before editing.']),
    '',
    'Dependency context (inspect only unless a selected fix demonstrably requires a change):',
    ...(dependencies.length
      ? dependencies.map(
          (pointer) =>
            `- ${pointer}${sourceFileForPath(pointer) ? ` (${sourceFileForPath(pointer)})` : ''}`,
        )
      : [
          '- No additional dependency paths verified from the current native Project graph. Inspect relevant references before changing them.',
        ]),
    '',
    'Constraints:',
    '- Work only within this selected Project root. Do not change unrelated records, files, warnings excluded by scope, or the currently active Project if different.',
    '- Preserve original YAML, comments and user-written values. Do not invent defaults, fabricate a Project, silently normalize malformed source, or overwrite external edits.',
    '- Read AGENTS.md and the generated NovelTea Agent Kit: .noveltea/agent/GUIDE.md, concepts/, reference/, and schemas/ as needed. If the kit is missing, prepare it with `noveltea repair project` before working; this prepares guidance, not authored source.',
    '- Use the installed CLI schema as the only supported current Project format. Older format conversion requires explicit user authorization; never silently downgrade newer source.',
    '- Inspect and repair the physical YAML source directly if parsing/normalization prevents structured editing.',
    '- Run `noveltea validate` only after the manifest and Project can be parsed by the installed CLI; before that, use source inspection and the generated Agent Kit. Do not claim validation succeeded unless it ran successfully.',
  ];
  if (input.recognition === 'weak')
    lines.push(
      '- Candidate evidence is weak (lone unrecognized manifest). Do not modify files without explicit user authorization.',
    );
  if (candidateFormatRisk(input.manifest) === 'newer')
    lines.push(
      '- WARNING: This Project declares a newer schema version. The installed editor/CLI may not understand it; transformation may destroy data. Do not run a conversion without affirmative user authorization.',
    );
  return lines.join('\n');
}
