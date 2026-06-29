import { z } from 'zod';
import { buildJsonPointer, getJsonAtPointer, hasJsonAtPointer } from '@/project/json-pointer';
import { isJsonArray, isJsonObject, toJsonValue, type JsonValue } from '@/project/json-value';
import type { CommandDiagnostic, CommandHandler, CommandHandlerResult } from './command-types';

const jsonPointerSchema = z.string().refine((value) => value === '' || value.startsWith('/'), {
  message: 'Expected a JSON pointer path.',
});

const patchOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), path: jsonPointerSchema, value: z.unknown() }),
  z.object({ op: z.literal('replace'), path: jsonPointerSchema, value: z.unknown() }),
  z.object({ op: z.literal('remove'), path: jsonPointerSchema }),
]);

const pathValueSchema = z.object({
  path: jsonPointerSchema,
  value: z.unknown(),
});

const pathOnlySchema = z.object({ path: jsonPointerSchema });

const recordSchema = z.object({
  collection: z.string().min(1),
  entityId: z.string().min(1),
  record: z.unknown(),
});

const deleteRecordSchema = z.object({
  collection: z.string().min(1),
  entityId: z.string().min(1),
});

function error(message: string, path?: string): CommandDiagnostic {
  return { severity: 'error', message, path };
}

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown): { ok: true; value: T } | { ok: false; diagnostics: CommandDiagnostic[] } {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    diagnostics: parsed.error.issues.map((issue) => error(issue.message, issue.path.length ? `/${issue.path.join('/')}` : undefined)),
  };
}

export const projectApplyPatchCommand: CommandHandler = ({ payload }) => {
  const parsed = parsePayload(z.array(patchOperationSchema), payload);
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  return {
    patches: parsed.value.map((operation) =>
      operation.op === 'remove'
        ? { op: operation.op, path: operation.path }
        : { op: operation.op, path: operation.path, value: toJsonValue(operation.value) },
    ),
    affectedPaths: parsed.value.map((operation) => operation.path),
  };
};

export const projectReplaceAtPathCommand: CommandHandler = ({ document, payload }) => {
  const parsed = parsePayload(pathValueSchema, payload);
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  if (!hasJsonAtPointer(document, parsed.value.path)) {
    return { patches: [], diagnostics: [error('Replace target does not exist.', parsed.value.path)] };
  }
  return {
    patches: [{ op: 'replace', path: parsed.value.path, value: toJsonValue(parsed.value.value) }],
    affectedPaths: [parsed.value.path],
  };
};

export const projectAddAtPathCommand: CommandHandler = ({ document, payload }) => {
  const parsed = parsePayload(pathValueSchema, payload);
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  if (parsed.value.path !== '') {
    const parent = parsed.value.path.slice(0, parsed.value.path.lastIndexOf('/')) || '';
    if (!hasJsonAtPointer(document, parent)) {
      return { patches: [], diagnostics: [error('Add parent path does not exist.', parent)] };
    }
  }
  return {
    patches: [{ op: 'add', path: parsed.value.path, value: toJsonValue(parsed.value.value) }],
    affectedPaths: [parsed.value.path],
  };
};

export const projectRemoveAtPathCommand: CommandHandler = ({ document, payload }) => {
  const parsed = parsePayload(pathOnlySchema, payload);
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  if (parsed.value.path === '') {
    return { patches: [], diagnostics: [error('Cannot remove the project document root.', parsed.value.path)] };
  }
  if (!hasJsonAtPointer(document, parsed.value.path)) {
    return { patches: [], diagnostics: [error('Remove target does not exist.', parsed.value.path)] };
  }
  return { patches: [{ op: 'remove', path: parsed.value.path }], affectedPaths: [parsed.value.path] };
};

function normalizeCurrentRecord(collection: string, entityId: string, record: JsonValue): { record: JsonValue; diagnostics: CommandDiagnostic[] } {
  const diagnostics: CommandDiagnostic[] = [];
  if (isJsonArray(record)) {
    const next = [...record];
    if (next.length === 0 || typeof next[0] !== 'string') {
      diagnostics.push(error('Legacy-shaped entity record must have a string ID in index 0.', buildJsonPointer([collection, entityId, '0'])));
      return { record, diagnostics };
    }
    if (next[0] !== entityId) {
      next[0] = entityId;
      diagnostics.push({
        severity: 'warning',
        path: buildJsonPointer([collection, entityId, '0']),
        message: 'Entity record id did not match the map key and was normalized.',
      });
    }
    return { record: next, diagnostics };
  }
  return { record, diagnostics };
}

export const entityReplaceRecordCommand: CommandHandler = ({ document, payload }) => {
  const parsed = parsePayload(recordSchema, payload);
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  const { collection, entityId } = parsed.value;
  const collectionPath = buildJsonPointer([collection]);
  if (!hasJsonAtPointer(document, collectionPath)) {
    return { patches: [], diagnostics: [error('Entity collection does not exist.', collectionPath)] };
  }
  const collectionValue = getJsonAtPointer(document, collectionPath);
  if (!isJsonObject(collectionValue)) {
    return { patches: [], diagnostics: [error('Entity collection is not an object.', collectionPath)] };
  }
  const normalized = normalizeCurrentRecord(collection, entityId, toJsonValue(parsed.value.record));
  if (normalized.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return { patches: [], diagnostics: normalized.diagnostics };
  }
  const path = buildJsonPointer([collection, entityId]);
  return {
    patches: [
      Object.prototype.hasOwnProperty.call(collectionValue, entityId)
        ? { op: 'replace', path, value: normalized.record }
        : { op: 'add', path, value: normalized.record },
    ],
    diagnostics: normalized.diagnostics,
    affectedPaths: [path],
  };
};

export const rawJsonReplaceRecordCommand = entityReplaceRecordCommand;

export const entityDeleteRecordCommand: CommandHandler = ({ document, payload }) => {
  const parsed = parsePayload(deleteRecordSchema, payload);
  if (!parsed.ok) return { patches: [], diagnostics: parsed.diagnostics };
  const path = buildJsonPointer([parsed.value.collection, parsed.value.entityId]);
  if (!hasJsonAtPointer(document, path)) {
    return { patches: [], diagnostics: [error('Entity record does not exist.', path)] };
  }
  return { patches: [{ op: 'remove', path }], affectedPaths: [path] };
};

export function createBuiltinCommandHandlers(): Record<string, CommandHandler> {
  return {
    'project.applyPatch': projectApplyPatchCommand,
    'project.replaceAtPath': projectReplaceAtPathCommand,
    'project.addAtPath': projectAddAtPathCommand,
    'project.removeAtPath': projectRemoveAtPathCommand,
    'rawJson.replaceRecord': rawJsonReplaceRecordCommand,
    'entity.replaceRecord': entityReplaceRecordCommand,
    'entity.deleteRecord': entityDeleteRecordCommand,
  };
}

export function labelForCommand(type: string): string {
  switch (type) {
    case 'project.applyPatch':
      return 'Apply project patch';
    case 'project.replaceAtPath':
      return 'Replace project value';
    case 'project.addAtPath':
      return 'Add project value';
    case 'project.removeAtPath':
      return 'Remove project value';
    case 'rawJson.replaceRecord':
      return 'Replace raw JSON record';
    case 'entity.replaceRecord':
      return 'Replace entity record';
    case 'entity.deleteRecord':
      return 'Delete entity record';
    default:
      return type;
  }
}

export type BuiltinCommandHandlerResult = CommandHandlerResult;
