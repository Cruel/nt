import { authoringRecordSchemas } from '../project-schema/authoring-records';
import { parseRestrictedYamlDocument } from './restricted-yaml-source';
import { encodeStructuredYaml } from './structured-yaml-source';
import { annotatedYamlPaths } from './yaml-comment-impact';

/** Restricted YAML is a source spelling of the existing strict Variable record, not a new model. */
export const variableYamlSourceSchema = authoringRecordSchemas.variables.extend({
  data: authoringRecordSchemas.variables.shape.data
    .omit({ kind: true })
    .meta(authoringRecordSchemas.variables.shape.data.meta() ?? {}),
});

export function decodeVariableYaml(text: string): unknown {
  const value = parseRestrictedYamlDocument(text).toJS();
  return authoringRecordSchemas.variables.parse(variableYamlSourceSchema.parse(value));
}

export function encodeVariableYaml(
  value: unknown,
  previousText?: string,
  keepCommentedDefaults = false,
): string {
  const parsed = authoringRecordSchemas.variables.parse(value);
  const data: Record<string, unknown> = { type: parsed.data.type, value: parsed.data.value };
  if (parsed.data.nullable) data.nullable = true;
  if (parsed.data.scope !== 'global') data.scope = parsed.data.scope;
  if (parsed.data.enumValues !== undefined) data.enumValues = parsed.data.enumValues;
  const target = {
    id: parsed.id,
    label: parsed.label,
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    data,
  };
  if (previousText !== undefined) {
    const previous = parseRestrictedYamlDocument(previousText).toJS() as {
      data?: Record<string, unknown>;
    };
    // Unchanged explicit defaults are authored intent; newly selected defaults become sparse.
    for (const key of ['nullable', 'scope'] as const) {
      if (
        previous.data &&
        Object.hasOwn(previous.data, key) &&
        (previous.data[key] === parsed.data[key] ||
          (keepCommentedDefaults && annotatedYamlPaths(previousText).has(`data.${key}`)))
      )
        data[key] = parsed.data[key];
    }
  }
  return encodeStructuredYaml(target, previousText);
}
