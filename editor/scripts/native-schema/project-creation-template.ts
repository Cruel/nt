import type { AuthoringProject } from '../../src/shared/project-schema/authoring-project';
import {
  PROJECT_WORKSPACE_SCHEMA,
  PROJECT_WORKSPACE_SCHEMA_VERSION,
} from '../../src/shared/project-workspace/project-workspace-contracts';
import { encodeStructuredYaml } from '../../src/shared/project-workspace/structured-yaml-source';
import { encodeSparseRecordYaml } from '../../src/shared/project-workspace/sparse-record-yaml-source';

/** Build-host-only encoding of the generated empty Project creation template. */
export function encodeNativeCreationTemplate(project: AuthoringProject): Record<string, string> {
  const localization = project.localization;
  return {
    'project.yaml': encodeStructuredYaml({
      schema: PROJECT_WORKSPACE_SCHEMA,
      schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
      project: project.project,
      settings: project.settings,
      export: project.export,
      bootstrapModule: project.bootstrapModule,
      inventories: project.inventories,
      interactableInstances: project.interactableInstances,
    }),
    'traits.yaml': encodeStructuredYaml(project.traits),
    'editor.yaml': encodeStructuredYaml({ chapters: {}, tags: {}, recordMetadata: {} }),
    'i18n/project.yaml': encodeStructuredYaml({
      sourceLocale: localization.sourceLocale,
      sourceLocaleLock: localization.sourceLocaleLock,
      defaultLocale: localization.defaultLocale,
      locales: localization.locales,
    }),
    'i18n/messages.yaml': encodeStructuredYaml({
      messages: localization.messages,
      structuredMessageIds: localization.structuredMessageIds,
    }),
    'i18n/tracking.yaml': encodeStructuredYaml(localization.sourceMessageTracking),
    'i18n/usage-notes.yaml': encodeStructuredYaml(localization.usageNotes),
    'i18n/orphans.yaml': encodeStructuredYaml(localization.orphanedMessages),
    'records/scripts/bootstrap.yaml': encodeSparseRecordYaml('scripts', {
      ...project.scripts.bootstrap,
      data: {
        ...project.scripts.bootstrap!.data,
        source: { kind: 'project-file', path: 'scripts/bootstrap.lua' },
      },
    }),
    'scripts/bootstrap.lua': 'return {}\n',
  };
}
