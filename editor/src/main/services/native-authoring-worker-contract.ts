import { z } from 'zod';

// Certification-only transport. The main process never sends a renderer-selected
// filesystem path to the worker: its root is resolved from active Project authority.
export const nativeAuthoringDiagnosticSchema = z
  .object({
    path: z.string(),
    code: z.string(),
    message: z.string(),
    severity: z.enum(['error', 'warning', 'info']),
  })
  .strict();

const workingSnapshotFields = {
  workingRevision: z.number().int().nonnegative(),
  diskSourceRevision: z.string(),
  source: z.unknown(),
  baseline: z.unknown().optional(),
  normalized: z.unknown().nullable(),
  dirty: z.boolean(),
  valid: z.boolean(),
  diagnostics: z.array(nativeAuthoringDiagnosticSchema),
  conflictingPaths: z.array(z.string()).optional(),
};

export const nativeAuthoringRecordSnapshotSchema = z.object(workingSnapshotFields).strict();

export const nativeAuthoringSnapshotSchema = z
  .object({
    ...workingSnapshotFields,
    inventory: z.array(z.string()).optional(),
    recordSnapshots: z.record(z.string(), nativeAuthoringRecordSnapshotSchema).optional(),
  })
  .strict();

export const nativeAuthoringObservationSchema = z
  .object({
    authoritative: z.boolean(),
    scopedAuthority: z.boolean(),
    unchanged: z.boolean(),
    fullRescan: z.boolean(),
    error: z.string(),
    added: z.array(z.string()),
    changed: z.array(z.string()),
    removed: z.array(z.string()),
    revisions: z.record(z.string(), z.string()),
    watchPaths: z.array(z.string()),
    invalidSources: z.array(z.object({ path: z.string(), error: z.string() }).strict()),
    recordDiagnostics: z.array(nativeAuthoringDiagnosticSchema),
  })
  .strict();

export const nativeAuthoringResultSchema = z
  .object({
    accepted: z.boolean(),
    error: z.string(),
    snapshot: nativeAuthoringSnapshotSchema,
    affectedRecords: z.array(z.string()),
    diagnosticsAdded: z.array(nativeAuthoringDiagnosticSchema),
    diagnosticsRemoved: z.array(nativeAuthoringDiagnosticSchema),
  })
  .strict();

const base = { sessionId: z.string(), generation: z.number().int().positive() };
export const nativeAuthoringEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...base,
      type: z.literal('snapshot'),
      sequence: z.literal(0),
      snapshot: nativeAuthoringSnapshotSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('delta'),
      sequence: z.number().int().positive(),
      observation: nativeAuthoringObservationSchema,
      changedRecords: z.array(z.string()),
      changedSourcePaths: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('response'),
      requestId: z.number().int().positive(),
      result: z.union([nativeAuthoringResultSchema, nativeAuthoringObservationSchema, z.null()]),
    })
    .strict(),
  z.object({ ...base, type: z.literal('failure'), error: z.string() }).strict(),
]);

export const nativeAuthoringCommandSchema = z.discriminatedUnion('operation', [
  z.object({ requestId: z.number().int().positive(), operation: z.literal('observe') }).strict(),
  z
    .object({ requestId: z.number().int().positive(), operation: z.literal('coverageLost') })
    .strict(),
  z
    .object({
      requestId: z.number().int().positive(),
      operation: z.literal('inspect'),
      owner: z.string().min(1).max(2048),
    })
    .strict(),
  z
    .object({
      requestId: z.number().int().positive(),
      operation: z.literal('reconcile'),
      owner: z.string().min(1).max(2048),
    })
    .strict(),
  z
    .object({
      requestId: z.number().int().positive(),
      operation: z.literal('useDisk'),
      owner: z.string().min(1).max(2048),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      requestId: z.number().int().positive(),
      operation: z.literal('saveOwners'),
      owners: z.array(z.string().min(1).max(2048)).max(256),
      expectedRevision: z.number().int().nonnegative(),
      keepMine: z.boolean(),
      comments: z.enum(['keep', 'remove', 'cancel', 'perEdit']),
    })
    .strict(),
  z
    .object({
      requestId: z.number().int().positive(),
      operation: z.literal('hint'),
      path: z.string().min(1).max(2048),
    })
    .strict(),
  z
    .object({
      requestId: z.number().int().positive(),
      operation: z.literal('patch'),
      expectedRevision: z.number().int().nonnegative(),
      patches: z
        .array(
          z
            .object({
              operation: z.enum(['add', 'replace', 'remove']),
              path: z.string().max(2048),
              value: z.unknown().optional(),
            })
            .strict(),
        )
        .max(256),
      diskPreconditions: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z
    .object({
      requestId: z.number().int().positive(),
      operation: z.literal('save'),
      diskRevision: z.string().max(128),
    })
    .strict(),
]);

export type NativeAuthoringEvent = z.infer<typeof nativeAuthoringEventSchema>;
export type NativeAuthoringCommand = z.infer<typeof nativeAuthoringCommandSchema>;
