import { authoringProjectSchema } from '../../src/shared/project-schema/authoring-project';
import { nativeCheck } from '../../src/shared/project-schema/native-schema-operations';
import { authoringRecordSchemas } from '../../src/shared/project-schema/authoring-records';
import { conditionSchema } from '../../src/shared/project-schema/authoring-flow';
import { schemaSources } from '../../src/shared/project-schema/schema-reference';
import { z } from 'zod';
import { projectWorkspaceSourceSchemas } from '../../src/shared/project-workspace/project-workspace-service';

const title = (value: string) => value[0]!.toUpperCase() + value.slice(1);

// Certification-only witness: no currently admissible Project family has a normalized
// record key without a yet-unimplemented family-specific semantic operation.
export const certificationRecordKeysSchema = z.record(
  z.string().check(nativeCheck('string.trim', z.trim())),
  z.number(),
);

// Both effective records and the physical workspace schema roots are inventoried.
export const nativeSchemaSources: Readonly<Record<string, z.ZodType>> = {
  ...projectWorkspaceSourceSchemas,
  ZodRecordKeyCertification: certificationRecordKeysSchema,
  Project: authoringProjectSchema,
  Condition: conditionSchema,
  ...Object.fromEntries(
    Object.entries(authoringRecordSchemas).map(([family, schema]) => [
      `${title(family)}Record`,
      schema,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(schemaSources).map(([path, schema]) => [
      `Workspace${path.replace('.schema.json', '').split('/').map(title).join('')}`,
      schema,
    ]),
  ),
};
