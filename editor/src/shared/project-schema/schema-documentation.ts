import { z } from 'zod';

export type SchemaExampleValue =
  | null
  | boolean
  | number
  | string
  | readonly SchemaExampleValue[]
  | { readonly [key: string]: SchemaExampleValue };

export interface SchemaDocumentation {
  readonly name?: string;
  readonly description?: string;
  readonly notes?: readonly string[];
  readonly constraints?: readonly string[];
  readonly lifecycle?: readonly string[];
  readonly status?: string;
  readonly related?: readonly string[];
  readonly examples?: readonly {
    readonly title: string;
    readonly value: SchemaExampleValue;
    /** Source attribution for an imported checked fixture, not an unchecked external example. */
    readonly source?: string;
  }[];
}

export function withSchemaDocumentation<T extends z.ZodType>(
  schema: T,
  documentation: SchemaDocumentation,
): T {
  return schema.meta({
    ...(documentation.name ? { title: documentation.name } : {}),
    ...(documentation.description ? { description: documentation.description } : {}),
    'x-noveltea-documentation': documentation,
  });
}

export function readSchemaDocumentation(
  json: Record<string, unknown>,
): SchemaDocumentation | undefined {
  return json['x-noveltea-documentation'] as SchemaDocumentation | undefined;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(isJsonValue)
  );
}

export function validateSchemaExamples(
  schema: z.core.$ZodType,
  documentation: SchemaDocumentation | undefined,
): void {
  for (const example of documentation?.examples ?? []) {
    if (!isJsonValue(example.value))
      throw new Error(`Schema example '${example.title}' is not a JSON value.`);
    const parsed = z.safeParse(schema, example.value);
    if (!parsed.success)
      throw new Error(`Invalid schema example '${example.title}': ${parsed.error.message}`);
  }
}
