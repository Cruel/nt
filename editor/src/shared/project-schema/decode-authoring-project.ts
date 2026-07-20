import type { z } from 'zod';
import {
  AUTHORING_PROJECT_SCHEMA,
  AUTHORING_PROJECT_SCHEMA_VERSION,
  authoringCollectionKeys,
} from './authoring-collections';
import { authoringProjectSchema, type AuthoringProject } from './authoring-project';
import { validateAuthoringProject } from './authoring-validation';
import { emptyEditorProjectState } from './editor-project-state';
import {
  collectProjectValidationDiagnostics,
  createProjectValidationDiagnostic,
  projectValidationBoundariesForAuthoringPath,
  type ProjectValidationDiagnostic,
} from './project-validation';

export interface AuthoringEnumRepair {
  path: string;
  invalidValue: string;
  replacement: string;
  code: string;
}

export interface AuthoringEnumRepairPolicy {
  id: string;
  pointerPattern: string;
  acceptedValues: readonly string[];
  safeDefault: string;
  diagnosticCode: string;
  testFixture: string;
  matches(pathSegments: readonly string[]): boolean;
}

export interface AuthoringProjectDecodeResult {
  project: AuthoringProject | null;
  structuralDiagnostics: ProjectValidationDiagnostic[];
  semanticDiagnostics: ProjectValidationDiagnostic[];
  repairs: AuthoringEnumRepair[];
  differsFromDisk: boolean;
}

function exactPath(...segments: string[]) {
  return (candidate: readonly string[]) =>
    candidate.length === segments.length &&
    candidate.every((value, index) => value === segments[index]);
}

function roomExitTransitionPath(candidate: readonly string[]) {
  return (
    candidate.length === 7 &&
    candidate[0] === 'rooms' &&
    candidate[2] === 'data' &&
    candidate[3] === 'exits' &&
    candidate[5] === 'transition' &&
    candidate[6] === 'kind'
  );
}

export const AUTHORING_ENUM_REPAIR_POLICIES: readonly AuthoringEnumRepairPolicy[] = [
  {
    id: 'display-orientation',
    pointerPattern: '/settings/display/orientation',
    acceptedValues: ['landscape', 'portrait'],
    safeDefault: 'landscape',
    diagnosticCode: 'authoring.repair.display-orientation',
    testFixture: 'invalid-display-orientation',
    matches: exactPath('settings', 'display', 'orientation'),
  },
  {
    id: 'room-navigation-transition-kind',
    pointerPattern: '/settings/presentation/roomNavigationTransition/kind',
    acceptedValues: ['cut', 'fade', 'dissolve'],
    safeDefault: 'cut',
    diagnosticCode: 'authoring.repair.room-navigation-transition-kind',
    testFixture: 'invalid-default-room-navigation-transition',
    matches: exactPath('settings', 'presentation', 'roomNavigationTransition', 'kind'),
  },
  {
    id: 'room-exit-transition-kind',
    pointerPattern: '/rooms/*/data/exits/*/transition/kind',
    acceptedValues: ['cut', 'fade', 'dissolve'],
    safeDefault: 'cut',
    diagnosticCode: 'authoring.repair.room-exit-transition-kind',
    testFixture: 'invalid-room-exit-transition',
    matches: roomExitTransitionPath,
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function pointerForSegments(segments: readonly PropertyKey[]): string {
  if (segments.length === 0) return '/';
  return `/${segments.map(String).map(escapeJsonPointerSegment).join('/')}`;
}

function structuralDiagnostic(
  code: string,
  path: string,
  message: string,
): ProjectValidationDiagnostic {
  return createProjectValidationDiagnostic({
    code,
    severity: 'error',
    category: 'Project structure',
    path,
    message,
    boundaries: ['authoring', 'runtime-package'],
    ownerPaths: [path],
  });
}

function semanticDiagnostic(issue: z.core.$ZodIssue): ProjectValidationDiagnostic {
  const path = pointerForSegments(issue.path);
  return createProjectValidationDiagnostic({
    code: `authoring.schema.${issue.code}`,
    severity: 'error',
    category: 'Project validation',
    path,
    message: issue.message,
    boundaries: projectValidationBoundariesForAuthoringPath(path),
    ownerPaths: [path],
  });
}

function warningForRepair(repair: AuthoringEnumRepair): ProjectValidationDiagnostic {
  return createProjectValidationDiagnostic({
    code: repair.code,
    severity: 'warning',
    category: 'Project recovery',
    path: repair.path,
    message: `Replaced unknown value '${repair.invalidValue}' with '${repair.replacement}'.`,
    boundaries: ['authoring'],
    ownerPaths: [repair.path],
  });
}

function getAtPath(root: unknown, segments: readonly string[]): unknown {
  let current = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function setAtPath(root: unknown, segments: readonly string[], value: unknown): boolean {
  if (segments.length === 0) return false;
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (isRecord(current)) current = current[segment];
    else return false;
  }
  const finalSegment = segments.at(-1)!;
  if (Array.isArray(current)) current[Number(finalSegment)] = value;
  else if (isRecord(current)) current[finalSegment] = value;
  else return false;
  return true;
}

function enumeratePaths(
  value: unknown,
  prefix: string[] = [],
  result: string[][] = [],
): string[][] {
  if (Array.isArray(value)) {
    value.forEach((child, index) => enumeratePaths(child, [...prefix, String(index)], result));
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value))
      enumeratePaths(child, [...prefix, key], result);
  } else {
    result.push(prefix);
  }
  return result;
}

function applyKnownEnumRepairs(project: Record<string, unknown>): AuthoringEnumRepair[] {
  const repairs: AuthoringEnumRepair[] = [];
  for (const pathSegments of enumeratePaths(project)) {
    const policy = AUTHORING_ENUM_REPAIR_POLICIES.find((candidate) =>
      candidate.matches(pathSegments),
    );
    if (!policy) continue;
    const value = getAtPath(project, pathSegments);
    if (typeof value !== 'string' || policy.acceptedValues.includes(value)) continue;
    if (!setAtPath(project, pathSegments, policy.safeDefault)) continue;
    repairs.push({
      path: pointerForSegments(pathSegments),
      invalidValue: value,
      replacement: policy.safeDefault,
      code: policy.diagnosticCode,
    });
  }
  return repairs;
}

function collectBasicStructuralDiagnostics(project: Record<string, unknown>) {
  const diagnostics: ProjectValidationDiagnostic[] = [];
  if (project.schema !== AUTHORING_PROJECT_SCHEMA)
    diagnostics.push(
      structuralDiagnostic(
        'authoring.schema.unsupported',
        '/schema',
        `Project schema must be '${AUTHORING_PROJECT_SCHEMA}'.`,
      ),
    );
  if (project.schemaVersion !== AUTHORING_PROJECT_SCHEMA_VERSION)
    diagnostics.push(
      structuralDiagnostic(
        'authoring.schema.version.unsupported',
        '/schemaVersion',
        `Project schema version must be ${AUTHORING_PROJECT_SCHEMA_VERSION}.`,
      ),
    );
  if (!isRecord(project.project))
    diagnostics.push(
      structuralDiagnostic(
        'authoring.structure.project.invalid',
        '/project',
        'Project identity must be an object.',
      ),
    );
  else if (typeof project.project.id !== 'string')
    diagnostics.push(
      structuralDiagnostic(
        'authoring.structure.project.id.invalid',
        '/project/id',
        'Project identity requires a string ID.',
      ),
    );
  if (!isRecord(project.settings))
    diagnostics.push(
      structuralDiagnostic(
        'authoring.structure.settings.invalid',
        '/settings',
        'Project settings must be an object.',
      ),
    );
  if (!isRecord(project.properties))
    diagnostics.push(
      structuralDiagnostic(
        'authoring.structure.properties.invalid',
        '/properties',
        'Project properties must be an object.',
      ),
    );
  for (const collection of authoringCollectionKeys) {
    const records = project[collection];
    if (!isRecord(records)) {
      diagnostics.push(
        structuralDiagnostic(
          'authoring.structure.collection.invalid',
          `/${collection}`,
          `Collection '${collection}' must be an object.`,
        ),
      );
      continue;
    }
    for (const [id, record] of Object.entries(records)) {
      const base = `/${collection}/${escapeJsonPointerSegment(id)}`;
      if (!isRecord(record)) {
        diagnostics.push(
          structuralDiagnostic(
            'authoring.structure.record.invalid',
            base,
            'Project record must be an object.',
          ),
        );
        continue;
      }
      if (typeof record.id !== 'string' || typeof record.label !== 'string' || !('data' in record))
        diagnostics.push(
          structuralDiagnostic(
            'authoring.structure.record.identity.invalid',
            base,
            'Project record requires string id and label fields plus data.',
          ),
        );
    }
  }
  if (project.entrypoint !== null && project.entrypoint !== undefined) {
    if (!isRecord(project.entrypoint))
      diagnostics.push(
        structuralDiagnostic(
          'authoring.structure.entrypoint.invalid',
          '/entrypoint',
          'Entrypoint must be an object or null.',
        ),
      );
    else if (!['room', 'scene', 'dialogue'].includes(String(project.entrypoint.kind)))
      diagnostics.push(
        structuralDiagnostic(
          'authoring.structure.entrypoint.kind.unsupported',
          '/entrypoint/kind',
          'Entrypoint kind is not supported by this project schema.',
        ),
      );
  }
  return diagnostics;
}

function isSemanticSchemaIssue(issue: z.core.$ZodIssue): boolean {
  return ['too_small', 'too_big', 'invalid_format', 'custom'].includes(issue.code);
}

function attachEditorStateForSchema(project: Record<string, unknown>): Record<string, unknown> {
  return { ...project, editor: emptyEditorProjectState() };
}

export function decodeAuthoringProject(value: unknown): AuthoringProjectDecodeResult {
  if (!isRecord(value)) {
    return {
      project: null,
      structuralDiagnostics: [
        structuralDiagnostic(
          'authoring.structure.root.invalid',
          '/',
          'Project root must be an object.',
        ),
      ],
      semanticDiagnostics: [],
      repairs: [],
      differsFromDisk: false,
    };
  }

  const working = attachEditorStateForSchema(cloneJson(value));
  const structuralDiagnostics = collectBasicStructuralDiagnostics(working);
  if (structuralDiagnostics.length > 0) {
    return {
      project: null,
      structuralDiagnostics: collectProjectValidationDiagnostics(structuralDiagnostics),
      semanticDiagnostics: [],
      repairs: [],
      differsFromDisk: false,
    };
  }

  const repairs = applyKnownEnumRepairs(working);
  const strict = authoringProjectSchema.safeParse(working);
  if (strict.success) {
    return {
      project: strict.data,
      structuralDiagnostics: [],
      semanticDiagnostics: collectProjectValidationDiagnostics(
        repairs.map(warningForRepair),
        validateAuthoringProject(strict.data),
      ),
      repairs,
      differsFromDisk: repairs.length > 0,
    };
  }

  const semanticIssues = strict.error.issues.filter(isSemanticSchemaIssue);
  const structuralIssues = strict.error.issues.filter((issue) => !isSemanticSchemaIssue(issue));
  if (structuralIssues.length > 0) {
    return {
      project: null,
      structuralDiagnostics: collectProjectValidationDiagnostics(
        structuralIssues.map((issue) =>
          structuralDiagnostic(
            `authoring.structure.${issue.code}`,
            pointerForSegments(issue.path),
            issue.message,
          ),
        ),
      ),
      semanticDiagnostics: repairs.map(warningForRepair),
      repairs,
      differsFromDisk: repairs.length > 0,
    };
  }

  const semanticProject = working as unknown as AuthoringProject;
  return {
    project: semanticProject,
    structuralDiagnostics: [],
    semanticDiagnostics: collectProjectValidationDiagnostics(
      repairs.map(warningForRepair),
      semanticIssues.map(semanticDiagnostic),
      validateAuthoringProject(semanticProject),
    ),
    repairs,
    differsFromDisk: repairs.length > 0,
  };
}
