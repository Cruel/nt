import { describe, expect, it } from 'vite-plus/test';
import { authoringCollectionKeys } from '../../shared/project-schema/authoring-collections';
import { isValidLayoutContractId } from '../../shared/project-schema/authoring-common';
import {
  createAuthoringProject,
  isAuthoringProject,
  isValidEntityId,
  parseAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import {
  EDITOR_PROJECT_STATE_SCHEMA,
  stripEditorProjectState,
} from '../../shared/project-schema/editor-project-state';
import { testTranslation } from './fixtures/localization-workflow';

describe('authoring project schema', () => {
  it('creates a complete current project root with an explicit Bootstrap Module', () => {
    const project = createAuthoringProject({ id: 'demo-project', name: 'Demo Project' });
    expect(project).toMatchObject({
      schema: 'noveltea.authoring.project',
      project: { id: 'demo-project', name: 'Demo Project' },
      bootstrapModule: { $ref: { collection: 'scripts', id: 'bootstrap' } },
      entrypoint: null,
      localization: {
        sourceLocale: 'en',
        defaultLocale: 'en',
        locales: { en: { supported: true, parentLocale: null } },
        messages: {},
        structuredMessageIds: {},
        sourceMessageTracking: {},
        orphanedMessages: {},
        translations: {},
      },
      editor: { schema: EDITOR_PROJECT_STATE_SCHEMA, recordMetadata: {} },
    });
    for (const key of authoringCollectionKeys)
      if (key === 'scripts') expect(Object.keys(project.scripts)).toEqual(['bootstrap']);
      else expect(project[key]).toEqual({});
    expect('objects' in project).toBe(false);
    expect('actions' in project).toBe(false);
  });

  it('accepts canonical local/named Messages and sparse target translations', () => {
    const project = createAuthoringProject();
    project.localization = {
      sourceLocale: 'en',
      defaultLocale: 'fr',
      locales: {
        en: { supported: true, parentLocale: null },
        fr: { supported: true, parentLocale: null },
        'pt-BR': { supported: false, parentLocale: null },
      },
      messages: {
        '018f4f8c-9b5d-7ae2-9b36-4c8af613f012': { kind: 'local', source: 'Open' },
        '018f4f8c-9b5d-7ae2-9b36-4c8af613f013': {
          kind: 'named',
          key: 'room.foyer.title',
          source: 'Foyer {count}',
          arguments: { count: 'integer' },
        },
      },
      structuredMessageIds: {},
      sourceMessageTracking: {},
      orphanedMessages: {},
      translations: {
        fr: { '018f4f8c-9b5d-7ae2-9b36-4c8af613f013': testTranslation('{count} Hall') },
      },
    };

    expect(isAuthoringProject(project)).toBe(true);
    const brokenPlaceholder = structuredClone(project);
    brokenPlaceholder.localization.translations.fr!['018f4f8c-9b5d-7ae2-9b36-4c8af613f013']!.text =
      'Hall';
    expect(isAuthoringProject(brokenPlaceholder)).toBe(true);
    expect(validateAuthoringProject(brokenPlaceholder)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'localization.translation.placeholder-missing' }),
      ]),
    );
    const withoutStructuredOwnership = structuredClone(project) as unknown as {
      localization: Record<string, unknown>;
    };
    delete withoutStructuredOwnership.localization.structuredMessageIds;
    expect(isAuthoringProject(withoutStructuredOwnership)).toBe(false);
    const withoutSourceTracking = structuredClone(project) as unknown as {
      localization: Record<string, unknown>;
    };
    delete withoutSourceTracking.localization.sourceMessageTracking;
    expect(isAuthoringProject(withoutSourceTracking)).toBe(false);
    expect(
      isAuthoringProject({
        ...project,
        localization: { ...project.localization, catalogs: { en: { greeting: 'Hello' } } },
      }),
    ).toBe(false);
    expect(
      isAuthoringProject({
        ...project,
        localization: {
          ...project.localization,
          messages: {
            ...project.localization.messages,
            '018f4f8c-9b5d-7ae2-9b36-4c8af613f014': {
              kind: 'named',
              key: 'legacy-key',
              source: 'Legacy',
            },
          },
        },
      }),
    ).toBe(false);
  });

  it('rejects invalid locale policy and inheritance cycles', () => {
    const project = createAuthoringProject();
    project.localization.locales.fr = { supported: false, parentLocale: 'pt-BR' };
    project.localization.locales['pt-BR'] = { supported: true, parentLocale: 'fr' };
    project.localization.defaultLocale = 'fr';

    expect(isAuthoringProject(project)).toBe(false);

    project.localization.defaultLocale = 'en';
    project.localization.locales.fr = { supported: false, parentLocale: null };
    project.localization.locales['pt-BR'] = { supported: false, parentLocale: 'fr' };
    expect(isAuthoringProject(project)).toBe(true);
  });

  it('rejects the retired schemaVersion field, legacy collection names, and unknown root fields', () => {
    const project = createAuthoringProject();
    expect(isAuthoringProject(project)).toBe(true);
    expect(isAuthoringProject({ ...project, schemaVersion: 1 })).toBe(false);
    expect(isAuthoringProject({ ...project, objects: {} })).toBe(false);
    expect(isAuthoringProject({ ...project, unknown: true })).toBe(false);
  });

  it('rejects the retired export identity content field', () => {
    const project = createAuthoringProject();
    expect(
      isAuthoringProject({
        ...project,
        settings: {
          ...project.settings,
          app: {
            ...project.settings.app,
            lastExportedIdentity: {
              applicationId: 'org.example.previous',
              saveNamespace: 'previous-saves',
            },
          },
        },
      }),
    ).toBe(false);
  });

  it('keeps entity IDs kebab-only while Layout contract IDs also allow snake_case', () => {
    expect(isValidEntityId('valid-id-2')).toBe(true);
    expect(isValidEntityId('2-bad')).toBe(false);
    expect(isValidEntityId('bad_id')).toBe(false);
    expect(isValidEntityId('bad/id')).toBe(false);

    expect(isValidLayoutContractId('saved_count')).toBe(true);
    expect(isValidLayoutContractId('saved-count')).toBe(true);
    expect(isValidLayoutContractId('saved_count-2')).toBe(true);
    expect(isValidLayoutContractId('Saved_count')).toBe(false);
    expect(isValidLayoutContractId('saved__count')).toBe(false);
  });

  it('normalizes missing editor state and strips editor metadata', () => {
    const project = createAuthoringProject();
    const withoutEditor = { ...project } as Partial<typeof project>;
    delete withoutEditor.editor;
    expect(parseAuthoringProject(withoutEditor).editor.schema).toBe(EDITOR_PROJECT_STATE_SCHEMA);
    expect('editor' in (stripEditorProjectState(project) as Record<string, unknown>)).toBe(false);
    expect('editor' in project).toBe(true);
  });
});
