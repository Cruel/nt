import { decodeVariableYaml, encodeVariableYaml } from './variable-yaml-source';
import { decodeLayoutYaml, encodeLayoutYaml } from './layout-yaml-source';
import { decodeStructuredYaml, encodeStructuredYaml } from './structured-yaml-source';
import {
  decodeSparseRecordYaml,
  encodeSparseRecordYaml,
  type SparseRecordFamily,
} from './sparse-record-yaml-source';
/**
 * Physical source syntax belongs here, not to the normalized AuthoringProject or the
 * transaction writer. File ownership and schema admission remain with the workspace
 * projection; individual record families can select a different source codec later.
 */
export type CanonicalSourceSchema = {
  readonly _zod?: { readonly def?: unknown };
  safeParse?(value: unknown): { readonly success: boolean };
};

export function compareProjectWorkspaceUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function schemaDefinition(
  schema: CanonicalSourceSchema | undefined,
): Record<string, unknown> | undefined {
  const definition = schema?._zod?.def;
  return definition && typeof definition === 'object'
    ? (definition as Record<string, unknown>)
    : undefined;
}

function objectShape(
  schema: CanonicalSourceSchema,
): Record<string, CanonicalSourceSchema> | undefined {
  const definition = schemaDefinition(schema);
  return definition?.type === 'object'
    ? (definition.shape as Record<string, CanonicalSourceSchema>)
    : undefined;
}

function literalValues(schema: CanonicalSourceSchema | undefined): readonly unknown[] | undefined {
  const definition = schemaDefinition(schema);
  if (definition?.type === 'literal') return definition.values as readonly unknown[];
  if (
    definition?.type === 'optional' ||
    definition?.type === 'nullable' ||
    definition?.type === 'default' ||
    definition?.type === 'catch' ||
    definition?.type === 'readonly' ||
    definition?.type === 'nonoptional'
  )
    return literalValues(definition.innerType as CanonicalSourceSchema);
  return undefined;
}

function matchingUnionSchema(
  value: unknown,
  options: readonly CanonicalSourceSchema[],
  discriminator?: unknown,
): CanonicalSourceSchema | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  if (typeof discriminator === 'string') {
    const matched = options.find((option) =>
      literalValues(objectShape(option)?.[discriminator])?.includes(object[discriminator]),
    );
    if (matched) return matched;
  }
  const parsed = options.filter((option) => option.safeParse?.(value).success);
  if (parsed.length > 0) return parsed[0];
  const structurallyMatched = options.filter((option) => {
    const shape = objectShape(option);
    return shape !== undefined && Object.keys(object).every((key) => key in shape);
  });
  return structurallyMatched.length === 1 ? structurallyMatched[0] : undefined;
}

/** Schema objects retain declared field order; dictionaries sort by Unicode code point. */
function canonicalize(value: unknown, schema?: CanonicalSourceSchema): unknown {
  const definition = schemaDefinition(schema);
  const type = definition?.type;
  if (type === 'optional' || type === 'nullable' || type === 'default' || type === 'catch')
    return canonicalize(value, definition?.innerType as CanonicalSourceSchema);
  if (type === 'readonly' || type === 'nonoptional')
    return canonicalize(value, definition?.innerType as CanonicalSourceSchema);
  if (type === 'pipe') return canonicalize(value, definition?.out as CanonicalSourceSchema);
  if (type === 'lazy') {
    const getter = definition?.getter;
    return typeof getter === 'function'
      ? canonicalize(value, (getter as () => CanonicalSourceSchema)())
      : canonicalize(value);
  }
  if (type === 'array') {
    const element = definition?.element as CanonicalSourceSchema;
    return Array.isArray(value) ? value.map((item) => canonicalize(item, element)) : value;
  }
  if (type === 'record') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const item = definition?.valueType as CanonicalSourceSchema;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareProjectWorkspaceUnicodeCodePoints(left, right))
        .map(([key, nested]) => [key, canonicalize(nested, item)]),
    );
  }
  if (type === 'union' || type === 'discriminatedUnion') {
    const options = (definition?.options ?? []) as readonly CanonicalSourceSchema[];
    return canonicalize(value, matchingUnionSchema(value, options, definition?.discriminator));
  }
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const shape = definition?.shape as Record<string, CanonicalSourceSchema>;
    const object = value as Record<string, unknown>;
    const known = Object.keys(shape)
      .filter((key) => object[key] !== undefined)
      .map((key) => [key, canonicalize(object[key], shape[key])] as const);
    const unknown = Object.keys(object)
      .filter((key) => !(key in shape) && object[key] !== undefined)
      .sort(compareProjectWorkspaceUnicodeCodePoints)
      .map((key) => [key, canonicalize(object[key])] as const);
    return Object.fromEntries([...known, ...unknown]);
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareProjectWorkspaceUnicodeCodePoints(left, right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

export interface ProjectWorkspaceSourceCodec {
  readonly kind: 'json' | 'text' | 'yaml';
  decode(text: string): unknown;
  encode(
    value: unknown,
    schema?: CanonicalSourceSchema,
    previousText?: string,
    keepCommentedDefaults?: boolean,
  ): string;
}

const jsonCodec: ProjectWorkspaceSourceCodec = {
  kind: 'json',
  decode: (text) => JSON.parse(text) as unknown,
  encode: (value, schema) => `${JSON.stringify(canonicalize(value, schema), null, 2)}\n`,
};

const textCodec: ProjectWorkspaceSourceCodec = {
  kind: 'text',
  decode: (text) => text,
  encode: (value) => String(value),
};

const variableYamlCodec: ProjectWorkspaceSourceCodec = {
  kind: 'yaml',
  decode: decodeVariableYaml,
  encode: (value, _schema, previousText, keep) => encodeVariableYaml(value, previousText, keep),
};

const structuredYamlCodec: ProjectWorkspaceSourceCodec = {
  kind: 'yaml',
  decode: decodeStructuredYaml,
  encode: (value, schema, previousText) =>
    encodeStructuredYaml(
      previousText === undefined ? canonicalize(value, schema) : value,
      previousText,
    ),
};

const layoutYamlCodec: ProjectWorkspaceSourceCodec = {
  kind: 'yaml',
  decode: decodeLayoutYaml,
  encode: (value, schema, previousText, keep) =>
    encodeLayoutYaml(
      previousText === undefined ? canonicalize(value, schema) : value,
      previousText,
      keep,
    ),
};

/** The single physical-format selection used by cold open, reconciliation and projection. */
export function projectWorkspaceSourceCodec(file: string): ProjectWorkspaceSourceCodec {
  if (
    /^i18n\/(?:project|messages|usage-notes|tracking|orphans|(?:locales|assets)\/[^/]+)\.yaml$/u.test(
      file,
    )
  )
    return structuredYamlCodec;
  if (/^records\/layouts\/[^/]+\/layout\.yaml$/u.test(file)) return layoutYamlCodec;
  if (/^records\/variables\/[^/]+\.yaml$/u.test(file)) return variableYamlCodec;
  const record =
    /^records\/(assets|animations|materials|archetypes|scripts|rooms|maps|characters|interactables|verbs|interactions|dialogues|scenes|tests)\/[^/]+\.yaml$/u.exec(
      file,
    );
  if (record) {
    const family = record[1] as SparseRecordFamily;
    return {
      kind: 'yaml',
      decode: (text) => decodeSparseRecordYaml(family, text),
      encode: (value, schema, previousText, keep) =>
        encodeSparseRecordYaml(
          family,
          previousText === undefined ? canonicalize(value, schema) : value,
          previousText,
          keep,
        ),
    };
  }
  if (file === 'project.yaml' || file === 'traits.yaml' || file === 'editor.yaml')
    return structuredYamlCodec;
  return file.endsWith('.json') ? jsonCodec : textCodec;
}
