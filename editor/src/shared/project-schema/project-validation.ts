import type { ToolDiagnostic } from '../editor-tooling';

export type ProjectValidationBoundary = 'authoring' | 'runtime-package' | 'platform-export';

export interface ProjectValidationDiagnostic extends ToolDiagnostic {
  code: string;
  boundaries: ProjectValidationBoundary[];
  ownerPaths: string[];
}

export type ProjectValidationDiagnosticLike = ToolDiagnostic & {
  code?: string;
  boundaries?: readonly ProjectValidationBoundary[];
  ownerPaths?: readonly string[];
};

export type ProjectValidationProducer =
  | 'authoring'
  | 'compiler'
  | 'runtime-export'
  | 'shader-material'
  | 'shader-compile'
  | 'asset-publication'
  | 'package-publication'
  | 'platform-export'
  | 'template'
  | 'toolchain'
  | 'signing';

export interface ProjectValidationClassification {
  producer: ProjectValidationProducer;
  boundaries?: readonly ProjectValidationBoundary[];
  codePrefix?: string;
  ownerPaths?:
    | readonly string[]
    | ((diagnostic: ProjectValidationDiagnosticLike) => readonly string[]);
}

const boundaryOrder: readonly ProjectValidationBoundary[] = [
  'authoring',
  'runtime-package',
  'platform-export',
];

const authoringCollectionNames = new Set([
  'assets',
  'characters',
  'dialogues',
  'interactables',
  'interactions',
  'layouts',
  'maps',
  'materials',
  'properties',
  'rooms',
  'scenes',
  'scripts',
  'shaders',
  'tags',
  'tests',
  'variables',
  'verbs',
]);

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeJsonPointer(path: string): string {
  if (!path || path === '/') return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

function normalizeCodeToken(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '.')
      .replaceAll(/^\.+|\.+$/g, '') || 'unknown'
  );
}

function rulePath(path: string): string {
  const segments = normalizeJsonPointer(path).split('/').slice(1).filter(Boolean);
  if (segments.length === 0) return 'root';

  return segments
    .map((segment, index) => {
      if (/^\d+$/.test(segment)) return 'item';
      if (index === 1 && authoringCollectionNames.has(segments[0] ?? '')) return 'record';
      if (segments[0] === 'settings' && segments[1] === 'app' && segments[2] === 'localized') {
        if (index === 3) return 'locale';
      }
      return normalizeCodeToken(segment.replaceAll('~1', '/').replaceAll('~0', '~'));
    })
    .join('.');
}

function generatedDiagnosticCode(
  diagnostic: ProjectValidationDiagnosticLike,
  classification: ProjectValidationClassification,
): string {
  const prefix = normalizeCodeToken(classification.codePrefix ?? classification.producer);
  const category = normalizeCodeToken(diagnostic.category ?? 'diagnostic');
  return `${prefix}.${category}.${rulePath(diagnostic.path)}`;
}

export function normalizeProjectValidationBoundaries(
  boundaries: readonly ProjectValidationBoundary[],
): ProjectValidationBoundary[] {
  const normalized = new Set(boundaries);
  if (normalized.has('runtime-package')) normalized.add('platform-export');
  return boundaryOrder.filter((boundary) => normalized.has(boundary));
}

export function projectValidationBoundariesForAuthoringPath(
  pathValue: string,
): ProjectValidationBoundary[] {
  const path = normalizeJsonPointer(pathValue);
  if (path === '/' || path === '/schema') {
    return normalizeProjectValidationBoundaries(['authoring', 'runtime-package']);
  }
  if (path === '/editor' || path.startsWith('/editor/')) return ['authoring'];
  if (path === '/tests' || path.startsWith('/tests/')) return ['authoring'];
  if (path === '/project/name' || path === '/project/version') {
    return ['authoring', 'platform-export'];
  }
  if (
    path === '/settings/app' ||
    path.startsWith('/settings/app/') ||
    path.startsWith('/settings/platformExport')
  ) {
    return ['authoring', 'platform-export'];
  }
  if (path.startsWith('/project/')) return ['authoring'];
  return normalizeProjectValidationBoundaries(['authoring', 'runtime-package']);
}

export function projectValidationBoundariesForCompilerDiagnostic(
  code: string,
  path: string,
): ProjectValidationBoundary[] {
  return code.startsWith('AUTHORING_')
    ? projectValidationBoundariesForAuthoringPath(path)
    : normalizeProjectValidationBoundaries(['authoring', 'runtime-package']);
}

function defaultBoundariesFor(
  diagnostic: ProjectValidationDiagnosticLike,
  producer: ProjectValidationProducer,
): ProjectValidationBoundary[] {
  switch (producer) {
    case 'authoring':
      return projectValidationBoundariesForAuthoringPath(diagnostic.path);
    case 'compiler':
    case 'runtime-export':
    case 'shader-material':
      return normalizeProjectValidationBoundaries(['authoring', 'runtime-package']);
    case 'shader-compile':
    case 'asset-publication':
    case 'package-publication':
      return normalizeProjectValidationBoundaries(['runtime-package']);
    case 'platform-export':
    case 'template':
    case 'toolchain':
    case 'signing':
      return ['platform-export'];
  }
}

function resolveOwnerPaths(
  diagnostic: ProjectValidationDiagnosticLike,
  classification: ProjectValidationClassification,
): string[] {
  const configured =
    typeof classification.ownerPaths === 'function'
      ? classification.ownerPaths(diagnostic)
      : classification.ownerPaths;
  const ownerPaths = diagnostic.ownerPaths ?? configured ?? [diagnostic.path];
  return [...new Set(ownerPaths.map(normalizeJsonPointer))].sort(compareStrings);
}

export function createProjectValidationDiagnostic(
  diagnostic: ProjectValidationDiagnosticLike & { code: string },
): ProjectValidationDiagnostic {
  const path = normalizeJsonPointer(diagnostic.path);
  return {
    severity: diagnostic.severity,
    path,
    message: diagnostic.message,
    ...(diagnostic.category ? { category: diagnostic.category } : {}),
    code: diagnostic.code,
    boundaries: normalizeProjectValidationBoundaries(diagnostic.boundaries ?? []),
    ownerPaths: [...new Set((diagnostic.ownerPaths ?? [path]).map(normalizeJsonPointer))].sort(
      compareStrings,
    ),
  };
}

export function createPlatformExportValidationDiagnostic(
  diagnostic: Omit<ProjectValidationDiagnosticLike, 'boundaries' | 'ownerPaths'> & {
    code: string;
    ownerPaths?: readonly string[];
  },
): ProjectValidationDiagnostic {
  return createProjectValidationDiagnostic({
    ...diagnostic,
    boundaries: ['platform-export'],
    ownerPaths: diagnostic.ownerPaths ?? [diagnostic.path],
  });
}

export function classifyProjectValidationDiagnostic(
  diagnostic: ProjectValidationDiagnosticLike,
  classification: ProjectValidationClassification,
): ProjectValidationDiagnostic {
  return createProjectValidationDiagnostic({
    ...diagnostic,
    code: diagnostic.code ?? generatedDiagnosticCode(diagnostic, classification),
    boundaries:
      diagnostic.boundaries ??
      classification.boundaries ??
      defaultBoundariesFor(diagnostic, classification.producer),
    ownerPaths: resolveOwnerPaths(diagnostic, classification),
  });
}

export function classifyProjectValidationDiagnostics(
  diagnostics: readonly ProjectValidationDiagnosticLike[],
  classification: ProjectValidationClassification,
): ProjectValidationDiagnostic[] {
  return diagnostics.map((diagnostic) =>
    classifyProjectValidationDiagnostic(diagnostic, classification),
  );
}

export function projectValidationDiagnosticKey(diagnostic: ProjectValidationDiagnostic): string {
  return [
    diagnostic.code,
    diagnostic.path,
    diagnostic.ownerPaths.join('\u0001'),
    diagnostic.severity,
    diagnostic.boundaries.join('\u0001'),
  ].join('\u0000');
}

export function collectProjectValidationDiagnostics(
  ...sources: readonly (readonly ProjectValidationDiagnostic[])[]
): ProjectValidationDiagnostic[] {
  const diagnostics = sources.flat();
  const sorted = [...diagnostics].sort((left, right) => {
    const code = compareStrings(left.code, right.code);
    if (code !== 0) return code;
    const path = compareStrings(left.path, right.path);
    if (path !== 0) return path;
    const severity = compareStrings(left.severity, right.severity);
    if (severity !== 0) return severity;
    const ownerPaths = compareStrings(
      left.ownerPaths.join('\u0001'),
      right.ownerPaths.join('\u0001'),
    );
    if (ownerPaths !== 0) return ownerPaths;
    const boundaries = compareStrings(
      left.boundaries.join('\u0001'),
      right.boundaries.join('\u0001'),
    );
    if (boundaries !== 0) return boundaries;
    return compareStrings(left.message, right.message);
  });

  const seen = new Set<string>();
  return sorted.filter((diagnostic) => {
    const key = projectValidationDiagnosticKey(diagnostic);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function projectValidationBlocksBoundary(
  diagnostic: ProjectValidationDiagnostic,
  boundary: ProjectValidationBoundary,
): boolean {
  return diagnostic.severity === 'error' && diagnostic.boundaries.includes(boundary);
}
