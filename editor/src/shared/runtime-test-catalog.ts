import { z } from 'zod';
import type { AuthoringProject } from './project-schema/authoring-project';
import {
  parseTestData,
  validateTestData,
  type TestSchemaDiagnostic,
} from './project-schema/authoring-tests';
import { buildRuntimePlaybackSpecFromTestData } from './project-schema/test-playback-project';

export const RUNTIME_TEST_CATALOG_SCHEMA = 'noveltea.runtime-test-catalog' as const;
export const RUNTIME_TEST_CATALOG_VERSION = 1 as const;

const runtimeTestCatalogDiagnosticSchema = z
  .object({
    severity: z.enum(['error', 'warning', 'info']),
    path: z.string(),
    message: z.string(),
    category: z.string().optional(),
  })
  .strict();

const runnableRuntimeTestCatalogEntrySchema = z
  .object({
    id: z.string().min(1),
    status: z.literal('runnable'),
    runner: z.enum(['runtime', 'runtime-ui']),
    spec: z.unknown(),
  })
  .strict();

const blockedRuntimeTestCatalogEntrySchema = z
  .object({
    id: z.string().min(1),
    status: z.literal('blocked'),
    diagnostics: z.array(runtimeTestCatalogDiagnosticSchema).min(1),
  })
  .strict();

export const runtimeTestCatalogSchema = z
  .object({
    schema: z.literal(RUNTIME_TEST_CATALOG_SCHEMA),
    version: z.literal(RUNTIME_TEST_CATALOG_VERSION),
    entries: z.array(
      z.discriminatedUnion('status', [
        runnableRuntimeTestCatalogEntrySchema,
        blockedRuntimeTestCatalogEntrySchema,
      ]),
    ),
  })
  .strict();

export type RuntimeTestCatalog = z.infer<typeof runtimeTestCatalogSchema>;
export type RuntimeTestCatalogEntry = RuntimeTestCatalog['entries'][number];

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}

function compareDiagnostics(left: TestSchemaDiagnostic, right: TestSchemaDiagnostic): number {
  return (
    compareUnicodeCodePoints(left.path, right.path) ||
    compareUnicodeCodePoints(left.severity, right.severity) ||
    compareUnicodeCodePoints(left.message, right.message) ||
    compareUnicodeCodePoints(left.category ?? '', right.category ?? '')
  );
}

export function buildRuntimeTestCatalog(project: AuthoringProject): RuntimeTestCatalog {
  const entries: RuntimeTestCatalogEntry[] = [];
  for (const testId of Object.keys(project.tests).sort(compareUnicodeCodePoints)) {
    const record = project.tests[testId]!;
    const validationDiagnostics = validateTestData(project, testId, record);
    const blockingValidationDiagnostics = validationDiagnostics.filter(
      (diagnostic) => diagnostic.severity === 'error',
    );
    const data = parseTestData(record.data);
    if (!data || blockingValidationDiagnostics.length > 0) {
      const diagnostics = (
        blockingValidationDiagnostics.length > 0
          ? blockingValidationDiagnostics
          : [
              {
                severity: 'error' as const,
                path: `/tests/${testId}/data`,
                message: 'Test data is invalid.',
                category: 'Tests',
              },
            ]
      ).sort(compareDiagnostics);
      entries.push({ id: testId, status: 'blocked', diagnostics });
      continue;
    }

    const playback = buildRuntimePlaybackSpecFromTestData(testId, data);
    const playbackErrors = playback.diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'error',
    );
    if (!playback.ok || !playback.runner || !playback.spec || playbackErrors.length > 0) {
      const diagnostics = playbackErrors
        .map((diagnostic) => ({
          severity: diagnostic.severity,
          path: diagnostic.path,
          message: diagnostic.message,
          ...(diagnostic.category ? { category: diagnostic.category } : {}),
        }))
        .sort(compareDiagnostics);
      entries.push({
        id: testId,
        status: 'blocked',
        diagnostics:
          diagnostics.length > 0
            ? diagnostics
            : [
                {
                  severity: 'error',
                  path: `/tests/${testId}/data`,
                  message: 'Test cannot be lowered to a runtime playback specification.',
                  category: 'Test playback',
                },
              ],
      });
      continue;
    }

    entries.push({ id: testId, status: 'runnable', runner: playback.runner, spec: playback.spec });
  }
  return { schema: RUNTIME_TEST_CATALOG_SCHEMA, version: RUNTIME_TEST_CATALOG_VERSION, entries };
}

export function findRuntimeTestCatalogEntry(
  catalog: RuntimeTestCatalog,
  testId: string,
): RuntimeTestCatalogEntry | undefined {
  return catalog.entries.find((entry) => entry.id === testId);
}
