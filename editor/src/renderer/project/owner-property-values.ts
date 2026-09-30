import { resolveArchetypeConfiguration } from '../../shared/project-schema/authoring-archetypes';
import type {
  AuthoringProject,
  AuthoringRecordBase,
} from '../../shared/project-schema/authoring-project';

export function resolveOwnerPropertyValues(
  project: AuthoringProject,
  record: AuthoringRecordBase,
  effectiveRecord: AuthoringRecordBase | null = null,
): Readonly<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  for (const traitId of effectiveRecord?.traits ?? record.traits ?? []) {
    for (const property of project.traits[traitId]?.properties ?? []) {
      if (property.defaultValue !== undefined) values[property.id] = property.defaultValue;
    }
  }
  const archetypeDefaults = record.archetype
    ? (resolveArchetypeConfiguration(project, record.archetype.$ref.id)?.defaultProperties ?? [])
    : [];
  for (const property of archetypeDefaults) {
    if (property.defaultValue !== undefined) values[property.id] = property.defaultValue;
  }
  for (const property of record.defaultProperties ?? []) {
    if (property.defaultValue !== undefined) values[property.id] = property.defaultValue;
  }
  for (const property of record.localProperties ?? []) values[property.id] = property.value;
  return values;
}
