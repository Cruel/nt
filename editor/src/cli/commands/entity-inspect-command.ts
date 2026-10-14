import { authoringRecordSchemas } from '../../shared/project-schema/authoring-records';
import { entityIdSchema } from '../../shared/project-schema/authoring-common';
import { projectWorkspaceSourceCodec } from '../../shared/project-workspace/project-workspace-source-codec';
import { cliDiagnostic, NOVELTEA_CLI_EXIT_CODES } from '../contracts';
import type { CliCommandDefinition } from './types';
import { CliCommandUsageError, parseCommandFlags, requireAuthoringCollection } from './types';

type Source = Record<string, unknown>;
const object = (value: unknown): value is Source =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Leaves describe source spelling; absent nested data is still part of effective meaning. */
function provenance(effective: unknown, source: unknown): unknown {
  if (Array.isArray(effective)) {
    const previous = Array.isArray(source) ? source : [];
    return effective.map((item, index) => provenance(item, previous[index]));
  }
  if (object(effective)) {
    const result: Source = {};
    for (const [key, value] of Object.entries(effective)) {
      const authored = object(source) ? source[key] : undefined;
      // Typed references are a single authored scalar in sparse YAML.
      if (key === '$ref' && typeof source === 'string') {
        result[key] = 'explicit';
      } else {
        result[key] = provenance(value, authored);
      }
    }
    return result;
  }
  return source === undefined ? 'default' : 'explicit';
}

export const entityInspectCommand: CliCommandDefinition = {
  path: ['entity', 'inspect'],
  parse(arguments_) {
    const parsed = parseCommandFlags(arguments_, ['--provenance']);
    if (parsed.positionals.length !== 2)
      throw new CliCommandUsageError(
        'Usage: noveltea entity inspect <collection> <id> [--provenance]',
      );
    const collection = requireAuthoringCollection(parsed.positionals[0]!);
    const id = parsed.positionals[1]!;
    if (!entityIdSchema.safeParse(id).success)
      throw new CliCommandUsageError(`Invalid record ID '${id}'.`);
    return {
      dryRun: true,
      mutation: false,
      requiredSemanticPaths: [`/${collection}/${id}`],
      async run({ snapshot, fileSystem }) {
        const record = snapshot.project[collection][id];
        if (!record)
          return {
            ok: false,
            exitCode: NOVELTEA_CLI_EXIT_CODES.semantic,
            diagnostics: [
              cliDiagnostic(
                'authoring.entity.not_found',
                `/${collection}/${id}`,
                'Record does not exist.',
              ),
            ],
          };
        const normalized = authoringRecordSchemas[collection].parse(record);
        let sourceProvenance: unknown;
        if (parsed.flags.has('--provenance')) {
          const file =
            collection === 'layouts'
              ? `records/layouts/${id}/layout.yaml`
              : `records/${collection}/${id}.yaml`;
          try {
            const content = await fileSystem.readText(
              fileSystem.joinPath(snapshot.projectRoot, file),
            );
            const { decodeStructuredYaml } =
              await import('../../shared/project-workspace/structured-yaml-source');
            const source = decodeStructuredYaml(content);
            sourceProvenance = provenance(normalized, source);
            // Source kind is not serialized in most sparse record families.
            if (object(sourceProvenance) && object(sourceProvenance.data))
              sourceProvenance.data.kind = 'default';
          } catch {
            // Some projects still have legacy JSON owners: inspect their authored fields.
            const legacy =
              collection === 'layouts'
                ? `records/layouts/${id}/layout.yaml`
                : `records/${collection}/${id}.yaml`;
            try {
              const content = await fileSystem.readText(
                fileSystem.joinPath(snapshot.projectRoot, legacy),
              );
              sourceProvenance = provenance(
                normalized,
                projectWorkspaceSourceCodec(legacy).decode(content),
              );
            } catch {
              return {
                ok: false,
                exitCode: NOVELTEA_CLI_EXIT_CODES.workspace,
                diagnostics: [
                  cliDiagnostic(
                    'WORKSPACE_SOURCE_READ',
                    `/${collection}/${id}`,
                    'Unable to inspect the tracked source for provenance.',
                  ),
                ],
              };
            }
          }
        }
        return {
          ok: true,
          diagnostics: [],
          fields: {
            collection,
            id,
            record: normalized,
            ...(parsed.flags.has('--provenance') ? { provenance: sourceProvenance } : {}),
          },
          humanSuccess: JSON.stringify(
            parsed.flags.has('--provenance')
              ? { record: normalized, provenance: sourceProvenance }
              : normalized,
            null,
            2,
          ),
        };
      },
    };
  },
};
