import { describe, expect, it } from 'vite-plus/test';
import {
  buildAuthoringSymbolTables,
  compilerNestedNamespaces,
  compileAuthoringProject,
  resolveAuthoringSymbol,
  resolveNestedAuthoringSymbol,
} from '../../shared/authoring-compiler';
import {
  compileSubjectSelector,
  lowerSharedAuthoringProject,
} from '../../shared/authoring-compiler-shared-lowering';
import { projectFlowPredictionIndexForTooling } from '../../shared/flow-prediction-tooling';
import {
  createLocalizationTranslation,
  createUseSourceLocalizationTarget,
  localizationMessageWorkflowView,
} from '../../shared/authoring-localization-workflow';
import { createLocalizedAssetVariant } from '../../shared/authoring-localized-assets';
import { lowerSceneAndRoomPrograms } from '../../shared/authoring-compiler-scene-room-lowering';
import { lowerDialogueAndInteractionPrograms } from '../../shared/authoring-compiler-dialogue-interaction-lowering';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { authoringCollectionKeys } from '../../shared/project-schema/authoring-collections';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultArchetypeData } from '../../shared/project-schema/authoring-archetypes';
import {
  defaultDialogueBlock,
  defaultDialogueData,
  defaultDialogueSegment,
} from '../../shared/project-schema/authoring-dialogues';
import { defaultInteractionData } from '../../shared/project-schema/authoring-interactions';
import { defaultInteractionProgram } from '../../shared/project-schema/authoring-interaction-programs';
import { defaultMapData } from '../../shared/project-schema/authoring-maps';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import { defaultHotspotBehavior } from '../../shared/project-schema/authoring-hotspots';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultSceneData, defaultSceneStep } from '../../shared/project-schema/authoring-scenes';
import { defaultTestData, defaultTestStep } from '../../shared/project-schema/authoring-tests';
import { defaultVariableData } from '../../shared/project-schema/authoring-variables';
import { defaultVerbData } from '../../shared/project-schema/authoring-verbs';
import { systemMessageDefinitionForKey } from '../../shared/project-schema/system-messages';
import { comprehensiveGoldenProject } from './fixtures/compiled-project-golden-projects';

function validProject(roomOrder: readonly string[] = ['foyer', 'hall']) {
  const project = createAuthoringProject({ id: 'compiler-demo', name: 'Compiler Demo' });
  for (const roomId of roomOrder) {
    const room = defaultRoomData(roomId);
    room.description.source = { kind: 'inline', text: roomId };
    project.rooms[roomId] = { id: roomId, label: roomId, data: room };
  }
  project.entrypoint = { kind: 'room', id: 'foyer' };
  return project;
}

describe('authoring compiler framework', () => {
  it('compiles explicit JSON data Asset dependencies without analyzing Data.load calls', () => {
    const project = validProject();
    project.assets.catalog = {
      id: 'catalog',
      label: 'Catalog',
      data: assetDataFromImportMetadata({
        kind: 'data',
        projectRelativePath: 'assets/data/catalog.json',
        extension: '.json',
        byteSize: 2,
        contentHash: 'catalog-hash',
        imageMetadata: null,
      }),
    };
    const layout = defaultLayoutData('Catalog');
    layout.lua.sourceText = "local catalog = assert(Data.load('catalog'))";
    layout.dependencies.data = [{ $ref: { collection: 'assets', id: 'catalog' } }];
    project.layouts.catalog = { id: 'catalog', label: 'Catalog', data: layout };
    const result = compileAuthoringProject(project);
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    expect(result.project.resources.layouts.find((entry) => entry.id === 'catalog')).toMatchObject({
      dependencies: { data: [{ kind: 'asset', id: 'catalog' }] },
      lua: { kind: 'inline', text: "local catalog = assert(Data.load('catalog'))" },
    });
    expect(result.project.resources.assets.find((entry) => entry.id === 'catalog')).toMatchObject({
      kind: 'data',
      path: 'assets/data/catalog.json',
    });
  });
  it('resolves reserved engine system Messages without Project catalog duplication', () => {
    const project = validProject();
    const layout = defaultLayoutData('System Message', 'document');
    layout.rml.sourceText =
      '<rml><head></head><body><nt-tr key="noveltea.shell.settings"/></body></rml>';
    project.layouts['system-message'] = {
      id: 'system-message',
      label: 'System Message',
      data: layout,
    };

    const result = compileAuthoringProject(project);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.diagnostics, null, 2)).toBe(true);
    if (!result.ok) return;

    const definition = systemMessageDefinitionForKey('noveltea.shell.settings');
    expect(definition).not.toBeNull();
    const compiled = result.project.resources.layouts.find(
      (candidate) => candidate.id === 'system-message',
    );
    expect(compiled?.rml).toEqual(
      expect.objectContaining({
        kind: 'inline',
        text: expect.stringContaining(`message="${definition!.id}"`),
      }),
    );
    expect(
      result.project.localization.catalogs
        .flatMap((catalog) => catalog.entries)
        .some((entry) => entry.messageId === definition!.id),
    ).toBe(false);
  });

  it('declares printable arguments for placeholders in structured inline Messages', () => {
    const project = validProject();
    const verb = defaultVerbData('Examine');
    verb.slots = [
      {
        id: 'target',
        label: { source: { kind: 'inline', text: 'Target' }, markup: 'plain' },
        prompt: { source: { kind: 'inline', text: 'Examine whom?' }, markup: 'plain' },
        selectors: [{ kind: 'family', family: 'interactable' }],
      },
    ];
    verb.bindingOrder = ['target'];
    verb.completedCommandText.source = { kind: 'inline', text: 'Examine {target}' };
    project.verbs.examine = { id: 'examine', label: 'Examine', data: verb };

    const result = compileAuthoringProject(project);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.diagnostics, null, 2)).toBe(true);
    if (!result.ok) return;

    expect(result.project.localization.catalogs[0]?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 'Examine {target}',
          arguments: [{ name: 'target', type: 'printable' }],
        }),
      ]),
    );
  });

  it('lowers Project overrides of reserved system Messages onto their engine runtime identity', () => {
    const project = validProject();
    const stableId = '11111111-1111-4111-8111-111111111119';
    project.localization.messages[stableId] = {
      kind: 'named',
      key: 'noveltea.shell.settings',
      source: 'Options',
    };

    const result = compileAuthoringProject(project);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.diagnostics, null, 2)).toBe(true);
    if (!result.ok) return;

    const definition = systemMessageDefinitionForKey('noveltea.shell.settings')!;
    expect(result.project.localization.catalogs[0]?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageId: definition.id, value: 'Options' }),
      ]),
    );
  });

  it('compiles target-locale overrides of engine system Messages through ordinary translation records', () => {
    const project = validProject();
    const stableId = '11111111-1111-4111-8111-111111111117';
    project.localization.messages[stableId] = {
      kind: 'named',
      key: 'noveltea.shell.settings',
      source: 'Options',
    };
    project.localization.locales['pt-BR'] = {
      supported: true,
      parentLocale: null,
      fontStack: null,
    };
    const view = localizationMessageWorkflowView(project, stableId)!;
    project.localization.translations['pt-BR'] = {
      [stableId]: createLocalizationTranslation(view, 'Opções do jogo', 'human', {
        review: 'reviewed',
      }),
    };

    const result = compileAuthoringProject(project);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.diagnostics, null, 2)).toBe(true);
    if (!result.ok) return;

    const definition = systemMessageDefinitionForKey('noveltea.shell.settings')!;
    const targetCatalog = result.project.localization.catalogs.find(
      (catalog) => catalog.locale === 'pt-BR',
    );
    expect(targetCatalog?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageId: definition.id, value: 'Opções do jogo' }),
      ]),
    );
  });

  it('rejects system Message overrides that change the engine-owned argument contract', () => {
    const project = validProject();
    project.localization.messages['11111111-1111-4111-8111-111111111116'] = {
      kind: 'named',
      key: 'noveltea.shell.settings',
      source: 'Options {section}',
      arguments: { section: 'string' },
    };

    const result = compileAuthoringProject(project);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AUTHORING_SCHEMA_CUSTOM',
          message: expect.stringContaining('engine-owned argument contract'),
        }),
      ]),
    );
  });

  it('rejects Project-owned named Messages in the reserved noveltea namespace', () => {
    const project = validProject();
    project.localization.messages['11111111-1111-4111-8111-111111111118'] = {
      kind: 'named',
      key: 'noveltea.project.custom',
      source: 'Collision',
    };

    const result = compileAuthoringProject(project);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'AUTHORING_SCHEMA_CUSTOM' })]),
    );
  });

  it('lowers typed Message Variables to compiled Message identities and rejects stale keys', () => {
    const project = validProject();
    project.localization.messages['11111111-1111-4111-8111-111111111111'] = {
      kind: 'named',
      key: 'ui.prompt',
      source: 'Prompt',
    };
    const data = defaultVariableData('message');
    data.nullable = false;
    data.value = { $message: 'ui.prompt' };
    project.variables.prompt = { id: 'prompt', label: 'Prompt', data };

    const result = compileAuthoringProject(project);
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics, null, 2)).toBe(
      true,
    );
    if (!result.ok) return;
    expect(result.project.properties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'prompt',
          type: 'message',
          defaultValue: expect.objectContaining({ kind: 'message', id: expect.any(Number) }),
        }),
      ]),
    );

    data.value = { $message: 'ui.missing' };
    const stale = compileAuthoringProject(project);
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AUTHORING_LOCALIZATION_MESSAGE_REFERENCE_MISSING' }),
      ]),
    );
  });

  it('narrowly lowers direct managed Lua localization calls to package Message references', () => {
    const project = validProject();
    project.localization.messages['11111111-1111-4111-8111-111111111111'] = {
      kind: 'named',
      key: 'ui.start',
      source: 'Start {count}',
      arguments: { count: 'integer' },
    };
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: `
        local local_text = Text.tr("Hello {name}", { name = "Ada" }, { context = "Greeting" })
        local named_text = Text.msg("ui.start", { count = 2 })
        local nested_text = Text.tr("Outer {inner}", { inner = Text.msg("ui.start", { count = 3 }) })
        local alias = Text.tr
        local untouched = alias("Not managed")
        return { local_text = local_text, named_text = named_text, nested_text = nested_text, untouched = untouched }
      `,
    };

    const result = compileAuthoringProject(project);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const source = result.project.resources.scripts.find(
      (script) => script.id === 'bootstrap',
    )!.source;
    expect(source.kind).toBe('inline-lua');
    if (source.kind !== 'inline-lua') return;
    expect(source.source).not.toContain('Text.tr("Hello {name}"');
    expect(source.source).not.toContain('Text.msg("ui.start"');
    expect(source.source).not.toContain('"Hello {name}"');
    expect(source.source).not.toContain('Greeting');
    expect(source.source).toMatch(/Text\.__message\(\d+, \{ name = "Ada" \}, nil\)/);
    expect(source.source).toMatch(/Text\.__message\(\d+, \{ count = 2 \}\)/);
    expect(source.source).toMatch(
      /Text\.__message\(\d+, \{ inner = Text\.__message\(\d+, \{ count = 3 \}\) \}\)/,
    );
    expect(source.source).toContain('alias("Not managed")');
    expect(result.project.localization.catalogs[0]?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 'Hello {name}',
          arguments: [{ name: 'name', type: 'printable' }],
        }),
        expect.objectContaining({
          value: 'Start {count}',
          arguments: [{ name: 'count', type: 'integer' }],
        }),
      ]),
    );
  });

  it('lowers literal Lua plural/select helpers into managed Message patterns', () => {
    const project = validProject();
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: `
        local plural = Text.plural(count, { one = "{value} item", other = "{value} items" }, { context = "Inventory count" })
        local selected = Text.select(gender, { female = "She", ["non-binary"] = "They", other = "They" })
        return { plural = plural, selected = selected }
      `,
    };

    const result = compileAuthoringProject(project);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const source = result.project.resources.scripts.find(
      (script) => script.id === 'bootstrap',
    )!.source;
    expect(source.kind).toBe('inline-lua');
    if (source.kind !== 'inline-lua') return;
    expect(source.source).not.toContain('Text.plural');
    expect(source.source).not.toContain('Text.select');
    expect(source.source).toMatch(/Text\.__message\(\d+, \{ value = count \}, nil\)/u);
    expect(source.source).toMatch(/Text\.__message\(\d+, \{ value = gender \}\)/u);
    expect(result.project.localization.catalogs[0]?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          arguments: [{ name: 'value', type: 'plural-number' }],
          pattern: expect.objectContaining({ nodes: expect.any(Array), root: 0 }),
        }),
        expect.objectContaining({
          arguments: [{ name: 'value', type: 'string' }],
          pattern: expect.objectContaining({ nodes: expect.any(Array), root: 0 }),
        }),
      ]),
    );
  });

  it('rejects non-literal managed Lua selector cases instead of executing or guessing them', () => {
    const project = validProject();
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: `local cases = { one = "one", other = "other" }\nreturn Text.plural(count, cases)`,
    };

    const result = compileAuthoringProject(project);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'authoring.localization.lua_cases_static' }),
      ]),
    );
  });

  it('compiles nested selectors on named Messages for RML without inline case grammar', () => {
    const project = validProject();
    project.localization.messages['11111111-1111-4111-8111-111111111111'] = {
      kind: 'named',
      key: 'ui.inventory.summary',
      source: '{count} items',
      arguments: { count: 'plural-number', gender: 'string' },
      pattern: {
        kind: 'plural',
        argument: 'count',
        cases: {
          one: {
            kind: 'select',
            argument: 'gender',
            cases: {
              female: { kind: 'text', text: '{count} item for her' },
              other: { kind: 'text', text: '{count} item' },
            },
          },
          other: { kind: 'text', text: '{count} items' },
        },
      },
    };
    const layout = defaultLayoutData('Inventory HUD', 'document');
    layout.rml.sourceText = `<rml><head></head><body data-model="noveltea">
      <nt-tr key="ui.inventory.summary" arg-count="{{ gameplay.inventory.items.size() }}" arg-gender="{{ gameplay.player.gender }}"/>
    </body></rml>`;
    project.layouts.inventory = { id: 'inventory', label: 'Inventory HUD', data: layout };

    const result = compileAuthoringProject(project);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.diagnostics, null, 2)).toBe(true);
    if (!result.ok) return;
    const entry = result.project.localization.catalogs[0]?.entries.find(
      (candidate) => candidate.pattern,
    );
    expect(entry?.pattern?.nodes.map((node) => node.kind)).toEqual(
      expect.arrayContaining(['plural', 'select', 'text']),
    );
  });

  it('lowers project and locale font stacks into the compiled localization contract', () => {
    const project = validProject();
    for (const id of ['body-font', 'latin-fallback', 'jp-fallback']) {
      project.assets[id] = {
        id,
        label: id,
        data: assetDataFromImportMetadata({
          kind: 'font',
          projectRelativePath: `assets/fonts/${id}.ttf`,
          aliases: [],
          imageMetadata: null,
        }),
      };
    }
    project.settings.text = {
      defaultFont: { $ref: { collection: 'assets', id: 'body-font' } },
      fontStack: [{ $ref: { collection: 'assets', id: 'latin-fallback' } }],
    };
    project.localization.locales.ja = {
      supported: true,
      parentLocale: null,
      fontStack: [{ $ref: { collection: 'assets', id: 'jp-fallback' } }],
    };
    project.localization.locales.fr = {
      supported: true,
      parentLocale: null,
      fontStack: null,
    };

    const result = compileAuthoringProject(project);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.diagnostics, null, 2)).toBe(true);
    if (!result.ok) return;

    expect(result.project.settings.text).toEqual({
      defaultFont: { kind: 'asset', id: 'body-font' },
      fontStack: [{ kind: 'asset', id: 'latin-fallback' }],
    });
    expect(
      result.project.localization.locales.find((locale) => locale.locale === 'ja')?.fontStack,
    ).toEqual([{ kind: 'asset', id: 'jp-fallback' }]);
    expect(
      result.project.localization.locales.find((locale) => locale.locale === 'fr')?.fontStack,
    ).toEqual([{ kind: 'asset', id: 'latin-fallback' }]);
  });

  it('flattens explicit locale inheritance into compiled catalogs while preserving use-source fallback', () => {
    const project = validProject();
    const messageId = '11111111-1111-4111-8111-111111111112';
    project.localization.messages[messageId] = {
      kind: 'named',
      key: 'ui.confirm',
      source: 'Confirm',
    };
    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    project.localization.locales['fr-CA'] = {
      supported: true,
      parentLocale: 'fr',
      fontStack: null,
    };
    const view = localizationMessageWorkflowView(project, messageId)!;
    project.localization.translations.fr = {
      [messageId]: createLocalizationTranslation(view, 'Confirmer', 'human', {
        review: 'reviewed',
      }),
    };

    const inherited = compileAuthoringProject(project);
    expect(inherited.ok).toBe(true);
    if (!inherited.ok) return;
    const fr = inherited.project.localization.catalogs.find((catalog) => catalog.locale === 'fr');
    const frCa = inherited.project.localization.catalogs.find(
      (catalog) => catalog.locale === 'fr-CA',
    );
    expect(fr?.entries.map((entry) => entry.value)).toContain('Confirmer');
    expect(frCa?.entries.map((entry) => entry.value)).toContain('Confirmer');

    project.localization.translations['fr-CA'] = {
      [messageId]: createUseSourceLocalizationTarget(view),
    };
    const useSource = compileAuthoringProject(project);
    expect(useSource.ok).toBe(true);
    if (!useSource.ok) return;
    const sourceFallbackCatalog = useSource.project.localization.catalogs.find(
      (catalog) => catalog.locale === 'fr-CA',
    );
    expect(sourceFallbackCatalog?.entries.map((entry) => entry.value)).not.toContain('Confirmer');
    expect(sourceFallbackCatalog?.entries.map((entry) => entry.value)).not.toContain('Confirm');
  });

  it('requires target plural categories for the target locale', () => {
    const project = validProject();
    const messageId = '11111111-1111-4111-8111-111111111111';
    project.localization.messages[messageId] = {
      kind: 'named',
      key: 'ui.inventory.count',
      source: '{count} items',
      arguments: { count: 'plural-number' },
      pattern: {
        kind: 'plural',
        argument: 'count',
        cases: {
          one: { kind: 'text', text: '{count} item' },
          other: { kind: 'text', text: '{count} items' },
        },
      },
    };
    project.localization.locales.ru = { supported: true, parentLocale: null, fontStack: null };
    project.localization.translations.ru = {
      [messageId]: {
        text: '{count} предметов',
        pattern: {
          kind: 'plural',
          argument: 'count',
          cases: {
            one: { kind: 'text', text: '{count} предмет' },
            other: { kind: 'text', text: '{count} предметов' },
          },
        },
        sourceFingerprint: 'fnv1a:00000000000000000000000000000000',
        origin: 'human',
        review: 'needs-review',
      },
    };

    const result = compileAuthoringProject(project);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'AUTHORING_LOCALIZATION_TRANSLATION_PLURAL_CATEGORY_MISSING',
        }),
      ]),
    );
  });

  it('lowers live RML nt-tr local and named Messages without authoring source metadata leakage', () => {
    const project = validProject();
    project.localization.messages['11111111-1111-4111-8111-111111111111'] = {
      kind: 'named',
      key: 'ui.items',
      source: 'Items: {count}',
      arguments: { count: 'integer' },
    };
    const layout = defaultLayoutData('Localized HUD', 'document');
    layout.rml.sourceText = `<rml><head></head><body data-model="noveltea">
      <p><nt-tr class="greeting">Hello <em>traveler</em>.</nt-tr></p>
      <nt-tr key="ui.items" arg-count="{{ gameplay.inventory.items.size() }}"/>
    </body></rml>`;
    project.layouts.localized = { id: 'localized', label: 'Localized HUD', data: layout };

    const result = compileAuthoringProject(project);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const compiled = result.project.resources.layouts.find((item) => item.id === 'localized')!;
    expect(compiled.rml.kind).toBe('inline');
    if (compiled.rml.kind !== 'inline') return;
    expect(compiled.rml.text).toMatch(/<nt-tr class="greeting" message="\d+"><\/nt-tr>/u);
    expect(compiled.rml.text).toMatch(
      /<nt-tr\s+arg-count="\{\{ gameplay\.inventory\.items\.size\(\) \}\}"\s+message="\d+"><\/nt-tr>/u,
    );
    expect(compiled.rml.text).not.toContain('key="ui.items"');
    expect(compiled.rml.text).not.toContain('Hello <em>traveler</em>.');
    expect(result.project.localization.catalogs[0]?.entries.map((entry) => entry.value)).toEqual(
      expect.arrayContaining(['Hello <em>traveler</em>.', 'Items: {count}']),
    );
  });

  it('rejects nested or interactive RML content inside nt-tr', () => {
    const project = validProject();
    const nested = defaultLayoutData('Invalid localized HUD', 'document');
    nested.rml.sourceText = `<rml><head></head><body>
      <nt-tr>Outer <nt-tr>Inner</nt-tr></nt-tr>
      <nt-tr><button onclick="act()">Click</button></nt-tr>
      <nt-tr><nt-case value="one">One</nt-case></nt-tr>
    </body></rml>`;
    project.layouts['invalid-localized'] = {
      id: 'invalid-localized',
      label: 'Invalid localized HUD',
      data: nested,
    };

    const result = compileAuthoringProject(project);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        'authoring.localization.rml_nested_message',
        'authoring.localization.rml_unsupported_content',
        'authoring.localization.rml_inline_case_unsupported',
      ]),
    );
  });

  it('reports missing named Message references during semantic validation', () => {
    const project = validProject();
    project.rooms.foyer!.data.description.source = {
      kind: 'localized',
      key: 'room.missing-description',
    };

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'AUTHORING_LOCALIZATION_MESSAGE_REFERENCE_MISSING',
        jsonPointer: '/rooms/foyer/data/description/source/key',
      }),
    );
    expect(result.stages.find((stage) => stage.name === 'semantic-validation')).toEqual({
      name: 'semantic-validation',
      status: 'failed',
    });
  });

  it('rejects dynamic managed Lua Message source/key forms instead of guessing', () => {
    const project = validProject();
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: `local key = "ui.start"\nreturn { Text.tr("a" .. "b"), Text.msg(key) }`,
    };
    const result = compileAuthoringProject(project);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        'authoring.localization.lua_source_literal',
        'authoring.localization.lua_named_key_literal',
      ]),
    );
  });

  it('lowers persisted supplemental prefetch intent into the generated prediction index', () => {
    const project = validProject();
    project.layouts.overlay = {
      id: 'overlay',
      label: 'Overlay',
      data: defaultLayoutData('Overlay'),
    };
    project.assets['hinted-image'] = {
      id: 'hinted-image',
      label: 'Hinted image',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/hinted.png',
        aliases: [],
        contentHash: 'hinted-hash',
        sampling: 'linear',
        imageMetadata: { width: 64, height: 64, hasAlpha: false, orientation: 1 },
      }),
    };
    project.prefetchHints['foyer-image'] = {
      id: 'foyer-image',
      target: { kind: 'asset', asset: { $ref: { collection: 'assets', id: 'hinted-image' } } },
      attachment: {
        kind: 'point',
        point: {
          kind: 'room-lifecycle',
          room: { $ref: { collection: 'rooms', id: 'foyer' } },
          stage: 'after-enter',
        },
      },
    };
    project.prefetchHints['hall-resident'] = {
      id: 'hall-resident',
      target: { kind: 'room', room: { $ref: { collection: 'rooms', id: 'foyer' } } },
      attachment: {
        kind: 'room',
        room: { $ref: { collection: 'rooms', id: 'hall' } },
        scope: 'resident',
      },
    };
    project.prefetchHints['overlay-point'] = {
      id: 'overlay-point',
      target: { kind: 'asset', asset: { $ref: { collection: 'assets', id: 'hinted-image' } } },
      attachment: {
        kind: 'point',
        point: {
          kind: 'resident-layout',
          layout: { $ref: { collection: 'layouts', id: 'overlay' } },
        },
      },
    };

    const compiled = compileAuthoringProject(project);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.project.flowPrediction?.supplementalHints).toHaveLength(3);
    const precise = compiled.project.flowPrediction?.supplementalHints?.find(
      (hint) => hint.id === 'foyer-image',
    );
    expect(precise?.attachment.kind).toBe('point');
    if (precise?.attachment.kind === 'point') {
      expect(
        compiled.project.flowPrediction?.slices[precise.attachment.slice]?.point,
      ).toMatchObject({
        kind: 'room-lifecycle',
        room: { id: 'foyer' },
        stage: 'after-enter',
      });
    }
    const resident = compiled.project.flowPrediction?.supplementalHints?.find(
      (hint) => hint.id === 'hall-resident',
    );
    expect(resident).toMatchObject({
      target: { kind: 'room', room: { id: 'foyer' } },
      attachment: { kind: 'room', room: { id: 'hall' }, scope: 'resident' },
    });
    expect(
      resident?.potentialExpansionSlices?.map(
        (slice) => compiled.project.flowPrediction?.slices[slice]?.point,
      ),
    ).toEqual([
      { kind: 'room-lifecycle', room: { kind: 'room', id: 'foyer' }, stage: 'before-enter' },
      { kind: 'room-lifecycle', room: { kind: 'room', id: 'foyer' }, stage: 'presentation' },
      { kind: 'room-lifecycle', room: { kind: 'room', id: 'foyer' }, stage: 'after-enter' },
    ]);
    const overlay = compiled.project.flowPrediction?.supplementalHints?.find(
      (hint) => hint.id === 'overlay-point',
    );
    expect(overlay?.attachment.kind).toBe('point');
    if (overlay?.attachment.kind === 'point') {
      expect(compiled.project.flowPrediction?.slices[overlay.attachment.slice]?.point).toEqual({
        kind: 'resident-layout',
        layout: { kind: 'layout', id: 'overlay' },
      });
    }
    expect(project.prefetchHints['foyer-image']).toBeDefined();
  });

  it('publishes generated Flow Prediction metadata without mutating authoring data', () => {
    const project = validProject();
    project.assets['next-background'] = {
      id: 'next-background',
      label: 'Next background',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/next-background.png',
        aliases: [],
        contentHash: 'next-background-hash',
        sampling: 'linear',
        imageMetadata: { width: 1920, height: 1080, hasAlpha: false, orientation: 1 },
      }),
    };

    const opening = defaultSceneData('Opening');
    opening.terminal = {
      kind: 'continue-scene',
      scene: { $ref: { collection: 'scenes', id: 'followup' } },
      inputs: [],
    };
    project.scenes.opening = { id: 'opening', label: 'Opening', data: opening };

    const followup = defaultSceneData('Followup');
    if (followup.stage.kind !== 'blank')
      throw new Error('Expected the default Scene Stage to be blank.');
    followup.stage.background.asset = { $ref: { collection: 'assets', id: 'next-background' } };
    project.scenes.followup = { id: 'followup', label: 'Followup', data: followup };
    project.entrypoint = { kind: 'scene', id: 'opening' };

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.flowPrediction).toBeDefined();
    expect('flowPrediction' in project).toBe(false);
  });

  it('recomputes semantic hint expansion when the hinted Scene dependencies change', () => {
    const project = validProject();
    for (const assetId of ['first-background', 'second-background']) {
      project.assets[assetId] = {
        id: assetId,
        label: assetId,
        data: assetDataFromImportMetadata({
          kind: 'image',
          projectRelativePath: `assets/images/${assetId}.png`,
          aliases: [],
          contentHash: `${assetId}-hash`,
          sampling: 'linear',
          imageMetadata: { width: 1920, height: 1080, hasAlpha: false, orientation: 1 },
        }),
      };
    }

    const hinted = defaultSceneData('Hinted');
    if (hinted.stage.kind !== 'blank') throw new Error('Expected blank default Scene Stage.');
    hinted.stage.background.asset = { $ref: { collection: 'assets', id: 'first-background' } };
    project.scenes.hinted = { id: 'hinted', label: 'Hinted', data: hinted };
    project.prefetchHints['foyer-hinted-scene'] = {
      id: 'foyer-hinted-scene',
      target: { kind: 'scene', scene: { $ref: { collection: 'scenes', id: 'hinted' } } },
      attachment: {
        kind: 'point',
        point: {
          kind: 'room-lifecycle',
          room: { $ref: { collection: 'rooms', id: 'foyer' } },
          stage: 'after-enter',
        },
      },
    };

    const expansionDependencies = () => {
      const compiled = compileAuthoringProject(project);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return [];
      const projection = projectFlowPredictionIndexForTooling(compiled.project.flowPrediction);
      return (
        projection?.supplementalHints.find((hint) => hint.id === 'foyer-hinted-scene')
          ?.potentialExpansion.dependencies ?? []
      );
    };

    expect(expansionDependencies()).toContainEqual({
      kind: 'asset',
      asset: { kind: 'asset', id: 'first-background' },
    });

    hinted.stage.background.asset = { $ref: { collection: 'assets', id: 'second-background' } };
    const changed = expansionDependencies();
    expect(changed).toContainEqual({
      kind: 'asset',
      asset: { kind: 'asset', id: 'second-background' },
    });
    expect(changed).not.toContainEqual({
      kind: 'asset',
      asset: { kind: 'asset', id: 'first-background' },
    });
  });

  it('recomputes semantic hint expansion when hinted Dialogue cue dependencies change', () => {
    const project = validProject();
    for (const assetId of ['first-voice', 'second-voice']) {
      project.assets[assetId] = {
        id: assetId,
        label: assetId,
        data: assetDataFromImportMetadata({
          kind: 'audio',
          projectRelativePath: `assets/audio/${assetId}.ogg`,
          extension: '.ogg',
          byteSize: 10,
          contentHash: `${assetId}-hash`,
          importedAt: '2026-01-01T00:00:00.000Z',
          originalName: `${assetId}.ogg`,
          originalPath: `/tmp/${assetId}.ogg`,
          imageMetadata: null,
        }),
      };
    }
    const dialogue = defaultDialogueData('Hinted Dialogue');
    const line = defaultDialogueSegment('line', 'line');
    line.cues = [
      {
        id: 'voice',
        kind: 'voice',
        position: { offset: 0, order: 0 },
        asset: { $ref: { collection: 'assets', id: 'first-voice' } },
        pausePolicy: 'gameplay',
        gain: 1,
        pan: 0,
        waitForCompletion: false,
        skipBehavior: 'stop',
      },
    ];
    dialogue.blocks = [{ ...defaultDialogueBlock('sequence', 'start'), segments: [line] }];
    project.dialogues.hinted = { id: 'hinted', label: 'Hinted', data: dialogue };
    project.prefetchHints['foyer-hinted-dialogue'] = {
      id: 'foyer-hinted-dialogue',
      target: { kind: 'dialogue', dialogue: { $ref: { collection: 'dialogues', id: 'hinted' } } },
      attachment: {
        kind: 'point',
        point: {
          kind: 'room-lifecycle',
          room: { $ref: { collection: 'rooms', id: 'foyer' } },
          stage: 'after-enter',
        },
      },
    };
    const expansionDependencies = () => {
      const compiled = compileAuthoringProject(project);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return [];
      return (
        projectFlowPredictionIndexForTooling(
          compiled.project.flowPrediction,
        )?.supplementalHints.find((hint) => hint.id === 'foyer-hinted-dialogue')?.potentialExpansion
          .dependencies ?? []
      );
    };
    expect(expansionDependencies()).toContainEqual({
      kind: 'audio',
      asset: { kind: 'asset', id: 'first-voice' },
      purpose: 'voice',
    });
    const voiceCue = line.cues[0]!;
    if (voiceCue.kind !== 'voice') throw new Error('fixture mismatch');
    voiceCue.asset = { $ref: { collection: 'assets', id: 'second-voice' } };
    const changed = expansionDependencies();
    expect(changed).toContainEqual({
      kind: 'audio',
      asset: { kind: 'asset', id: 'second-voice' },
      purpose: 'voice',
    });
    expect(changed).not.toContainEqual({
      kind: 'audio',
      asset: { kind: 'asset', id: 'first-voice' },
      purpose: 'voice',
    });
  });

  it('includes Choice effect Flow and nested supplemental hints in displayed hint expansion', () => {
    const project = validProject();
    for (const assetId of ['choice-child-image', 'nested-hint-image']) {
      project.assets[assetId] = {
        id: assetId,
        label: assetId,
        data: assetDataFromImportMetadata({
          kind: 'image',
          projectRelativePath: `assets/images/${assetId}.png`,
          aliases: [],
          contentHash: `${assetId}-hash`,
          sampling: 'linear',
          imageMetadata: { width: 64, height: 64, hasAlpha: false, orientation: 1 },
        }),
      };
    }

    const child = defaultSceneData('Choice Child');
    if (child.stage.kind !== 'blank') throw new Error('Expected blank default Scene Stage.');
    child.stage.background.asset = {
      $ref: { collection: 'assets', id: 'choice-child-image' },
    };
    project.scenes['choice-child'] = { id: 'choice-child', label: 'Choice Child', data: child };

    const dialogue = defaultDialogueData('Choice Hint');
    dialogue.entryBlockId = 'choice';
    dialogue.blocks = [
      defaultDialogueBlock('choice', 'choice'),
      defaultDialogueBlock('sequence', 'done'),
    ];
    dialogue.edges = [
      {
        id: 'choose-child',
        kind: 'choice',
        fromBlockId: 'choice',
        toBlockId: 'done',
        label: { source: { kind: 'inline', text: 'Child' }, markup: 'plain' },
        condition: { kind: 'always' },
        effects: [
          {
            id: 'call-choice-child',
            kind: 'call-scene',
            scene: { $ref: { collection: 'scenes', id: 'choice-child' } },
          },
        ],
        logged: true,
        autosaveSafePoint: false,
      },
    ];
    project.dialogues['choice-hint'] = {
      id: 'choice-hint',
      label: 'Choice Hint',
      data: dialogue,
    };

    project.prefetchHints['outer-dialogue-hint'] = {
      id: 'outer-dialogue-hint',
      target: {
        kind: 'dialogue',
        dialogue: { $ref: { collection: 'dialogues', id: 'choice-hint' } },
      },
      attachment: {
        kind: 'point',
        point: {
          kind: 'room-lifecycle',
          room: { $ref: { collection: 'rooms', id: 'foyer' } },
          stage: 'after-enter',
        },
      },
    };
    project.prefetchHints['nested-asset-hint'] = {
      id: 'nested-asset-hint',
      target: {
        kind: 'asset',
        asset: { $ref: { collection: 'assets', id: 'nested-hint-image' } },
      },
      attachment: {
        kind: 'point',
        point: {
          kind: 'scene-entry',
          scene: { $ref: { collection: 'scenes', id: 'choice-child' } },
        },
      },
    };

    const compiled = compileAuthoringProject(project);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const expansion = projectFlowPredictionIndexForTooling(
      compiled.project.flowPrediction,
    )?.supplementalHints.find((hint) => hint.id === 'outer-dialogue-hint')?.potentialExpansion;
    expect(expansion?.dependencies).toContainEqual({
      kind: 'asset',
      asset: { kind: 'asset', id: 'choice-child-image' },
    });
    expect(expansion?.dependencies).toContainEqual({
      kind: 'asset',
      asset: { kind: 'asset', id: 'nested-hint-image' },
    });
  });

  it('recomputes semantic Room hint expansion when entry lifecycle Flow changes', () => {
    const project = validProject();
    for (const assetId of ['first-arrival', 'second-arrival']) {
      project.assets[assetId] = {
        id: assetId,
        label: assetId,
        data: assetDataFromImportMetadata({
          kind: 'image',
          projectRelativePath: `assets/images/${assetId}.png`,
          aliases: [],
          contentHash: `${assetId}-hash`,
          sampling: 'linear',
          imageMetadata: { width: 64, height: 64, hasAlpha: false, orientation: 1 },
        }),
      };
      const scene = defaultSceneData(assetId);
      if (scene.stage.kind !== 'blank') throw new Error('Expected blank default Scene Stage.');
      scene.stage.background.asset = { $ref: { collection: 'assets', id: assetId } };
      project.scenes[assetId] = { id: assetId, label: assetId, data: scene };
    }
    const hall = project.rooms.hall!.data;
    hall.lifecycle.afterEnter = [
      {
        id: 'arrival',
        kind: 'call-scene',
        scene: { $ref: { collection: 'scenes', id: 'first-arrival' } },
      },
    ];
    project.prefetchHints['foyer-hinted-room'] = {
      id: 'foyer-hinted-room',
      target: { kind: 'room', room: { $ref: { collection: 'rooms', id: 'hall' } } },
      attachment: {
        kind: 'point',
        point: {
          kind: 'room-lifecycle',
          room: { $ref: { collection: 'rooms', id: 'foyer' } },
          stage: 'after-enter',
        },
      },
    };
    const expansionDependencies = () => {
      const compiled = compileAuthoringProject(project);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return [];
      return (
        projectFlowPredictionIndexForTooling(
          compiled.project.flowPrediction,
        )?.supplementalHints.find((hint) => hint.id === 'foyer-hinted-room')?.potentialExpansion
          .dependencies ?? []
      );
    };
    expect(expansionDependencies()).toContainEqual({
      kind: 'asset',
      asset: { kind: 'asset', id: 'first-arrival' },
    });
    const arrival = hall.lifecycle.afterEnter[0];
    if (!arrival || arrival.kind !== 'call-scene') throw new Error('Expected call-scene command.');
    arrival.scene = { $ref: { collection: 'scenes', id: 'second-arrival' } };
    const changed = expansionDependencies();
    expect(changed).toContainEqual({
      kind: 'asset',
      asset: { kind: 'asset', id: 'second-arrival' },
    });
    expect(changed).not.toContainEqual({
      kind: 'asset',
      asset: { kind: 'asset', id: 'first-arrival' },
    });
  });

  it('lowers Scene execution positions, local dependencies, and wait frontiers into prediction metadata', () => {
    const project = validProject();
    project.assets['scene-image'] = {
      id: 'scene-image',
      label: 'Scene image',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/scene-image.png',
        aliases: [],
        contentHash: 'scene-image-hash',
        sampling: 'linear',
        imageMetadata: { width: 1280, height: 720, hasAlpha: false, orientation: 1 },
      }),
    };
    const scene = defaultSceneData('Prediction Scene');
    scene.events = [
      {
        ...defaultSceneStep('set-background'),
        id: 'near-background',
        asset: { $ref: { collection: 'assets', id: 'scene-image' } },
      },
      {
        id: 'player-wait',
        label: 'Player Wait',
        enabled: true,
        type: 'wait',
        timeline: { trackId: 'main', startMs: 0, durationMs: 0 },
        completionDependencies: [],
        waitKind: 'input',
        skippable: false,
      },
    ];
    project.scenes.prediction = { id: 'prediction', label: 'Prediction', data: scene };
    project.entrypoint = { kind: 'scene', id: 'prediction' };

    const result = compileAuthoringProject(project);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prediction = result.project.flowPrediction!;
    const entry = prediction.slices.find(
      (slice) => slice.point.kind === 'scene-entry' && slice.point.scene.id === 'prediction',
    );
    const background = prediction.slices.find(
      (slice) =>
        slice.point.kind === 'scene-step' &&
        slice.point.scene.id === 'prediction' &&
        slice.point.stepId === 'near-background',
    );
    const wait = prediction.slices.find(
      (slice) =>
        slice.point.kind === 'scene-step' &&
        slice.point.scene.id === 'prediction' &&
        slice.point.stepId === 'player-wait',
    );
    expect(entry).toBeDefined();
    expect(background).toBeDefined();
    expect(wait?.frontier).toBe('strong-wait');
    expect(background!.dependencyGroups).toHaveLength(1);
    expect(prediction.dependencyGroups[background!.dependencyGroups[0]!]).toContainEqual({
      kind: 'asset',
      asset: { kind: 'asset', id: 'scene-image' },
    });
    expect(entry!.dependencyGroups).not.toEqual(background!.dependencyGroups);
  });

  it('coalesces adjacent prediction-inert Scene events while preserving every live resume position', () => {
    const project = validProject();
    project.assets['later-image'] = {
      id: 'later-image',
      label: 'Later image',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/later-image.png',
        aliases: [],
        contentHash: 'later-image-hash',
        sampling: 'linear',
        imageMetadata: { width: 64, height: 64, hasAlpha: false, orientation: 1 },
      }),
    };
    const scene = defaultSceneData('Compact Prediction Scene');
    scene.events = [
      { ...defaultSceneStep('show-text'), id: 'immediate-a', wait: 'immediate' },
      { ...defaultSceneStep('show-text'), id: 'immediate-c', wait: 'immediate' },
      { ...defaultSceneStep('show-text'), id: 'immediate-b', wait: 'immediate' },
      {
        ...defaultSceneStep('set-background'),
        id: 'later-background',
        asset: { $ref: { collection: 'assets', id: 'later-image' } },
      },
    ];
    project.scenes.compact = { id: 'compact', label: 'Compact', data: scene };
    project.entrypoint = { kind: 'scene', id: 'compact' };
    project.prefetchHints['precise-immediate-b'] = {
      id: 'precise-immediate-b',
      target: { kind: 'asset', asset: { $ref: { collection: 'assets', id: 'later-image' } } },
      attachment: {
        kind: 'point',
        point: {
          kind: 'scene-step',
          scene: { $ref: { collection: 'scenes', id: 'compact' } },
          stepId: 'immediate-b',
        },
      },
    };

    const result = compileAuthoringProject(project);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const prediction = result.project.flowPrediction!;
    const sceneSlices = prediction.slices.filter(
      (slice) =>
        (slice.point.kind === 'scene-entry' ||
          slice.point.kind === 'scene-step' ||
          slice.point.kind === 'scene-terminal') &&
        'scene' in slice.point &&
        slice.point.scene.id === 'compact',
    );
    expect(sceneSlices.length).toBeLessThan(scene.events.length + 2);

    const inert = sceneSlices.find(
      (slice) => slice.point.kind === 'scene-step' && slice.point.stepId === 'immediate-a',
    );
    expect(inert?.resumePoints).toEqual([
      { kind: 'scene-step', scene: { kind: 'scene', id: 'compact' }, stepId: 'immediate-c' },
    ]);
    const hinted = sceneSlices.find(
      (slice) => slice.point.kind === 'scene-step' && slice.point.stepId === 'immediate-b',
    );
    expect(hinted).toBeDefined();
    const compiledHint = prediction.supplementalHints?.find(
      (hint) => hint.id === 'precise-immediate-b',
    );
    expect(compiledHint?.attachment.kind).toBe('point');
    if (compiledHint?.attachment.kind === 'point') {
      expect(prediction.slices[compiledHint.attachment.slice]?.point).toEqual({
        kind: 'scene-step',
        scene: { kind: 'scene', id: 'compact' },
        stepId: 'immediate-b',
      });
    }
    expect(inert?.control).toMatchObject({ kind: 'sequential' });
    if (inert?.control.kind === 'sequential') {
      expect(prediction.slices[inert.control.successor!]?.point).toEqual({
        kind: 'scene-step',
        scene: { kind: 'scene', id: 'compact' },
        stepId: 'immediate-b',
      });
    }
    expect(hinted?.control).toMatchObject({ kind: 'sequential' });
    if (hinted?.control.kind === 'sequential') {
      expect(prediction.slices[hinted.control.successor!]?.point).toEqual({
        kind: 'scene-step',
        scene: { kind: 'scene', id: 'compact' },
        stepId: 'later-background',
      });
    }
  });

  it('lowers Dialogue execution positions, cue dependencies, effects, choices, and child Flow into prediction metadata', () => {
    const project = validProject();
    project.assets.voice = {
      id: 'voice',
      label: 'Voice',
      data: assetDataFromImportMetadata({
        kind: 'audio',
        projectRelativePath: 'assets/audio/voice.ogg',
        extension: '.ogg',
        byteSize: 10,
        contentHash: 'voice-hash',
        importedAt: '2026-01-01T00:00:00.000Z',
        originalName: 'voice.ogg',
        originalPath: '/tmp/voice.ogg',
        imageMetadata: null,
      }),
    };
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
    project.scenes.child = { id: 'child', label: 'Child', data: defaultSceneData('Child') };
    const dialogue = defaultDialogueData('Prediction Dialogue');
    dialogue.blocks = [
      {
        ...defaultDialogueBlock('sequence', 'start'),
        segments: [
          {
            ...defaultDialogueSegment('line', 'line'),
            cues: [
              {
                id: 'voice',
                kind: 'voice',
                position: { offset: 0, order: 0 },
                asset: { $ref: { collection: 'assets', id: 'voice' } },
                pausePolicy: 'gameplay',
                gain: 1,
                pan: 0,
                waitForCompletion: false,
                skipBehavior: 'stop',
              },
            ],
            effects: [
              {
                id: 'set-flag',
                kind: 'set-global-property',
                variable: { $ref: { collection: 'variables', id: 'flag' } },
                value: true,
              },
            ],
          },
          {
            ...defaultDialogueSegment('call-scene', 'child'),
            scene: { $ref: { collection: 'scenes', id: 'child' } },
            inputs: [],
            uiPolicy: 'preserve',
          },
        ],
      },
      defaultDialogueBlock('choice', 'choice'),
    ];
    dialogue.edges = [
      { id: 'next', kind: 'next', fromBlockId: 'start', toBlockId: 'choice' },
      {
        id: 'choose',
        kind: 'choice',
        fromBlockId: 'choice',
        toBlockId: 'start',
        label: { source: { kind: 'inline', text: 'Again' }, markup: 'plain' },
        condition: { kind: 'always' },
        effects: [],
        logged: true,
        autosaveSafePoint: false,
      },
    ];
    project.dialogues.prediction = { id: 'prediction', label: 'Prediction', data: dialogue };
    project.entrypoint = { kind: 'dialogue', id: 'prediction' };

    const result = compileAuthoringProject(project);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prediction = result.project.flowPrediction!;
    const position = (
      stage: string,
      options: { segmentId?: string; edgeId?: string; cursor?: number } = {},
    ) =>
      prediction.slices.find(
        (slice) =>
          slice.point.kind === 'dialogue-position' &&
          slice.point.dialogue.id === 'prediction' &&
          slice.point.stage === stage &&
          slice.point.segmentId === options.segmentId &&
          slice.point.edgeId === options.edgeId &&
          slice.point.cursor === (options.cursor ?? 0),
      );
    const cue = position('present-segment', { segmentId: 'line' });
    expect(cue).toBeDefined();
    expect(prediction.dependencyGroups[cue!.dependencyGroups[0]!]).toContainEqual({
      kind: 'audio',
      asset: { kind: 'asset', id: 'voice' },
      purpose: 'voice',
    });
    expect(position('apply-segment-effects', { segmentId: 'line' })?.program).toEqual([
      {
        commandId: 'set-flag',
        kind: 'set-global-property',
        property: { kind: 'property', id: 'flag' },
        value: true,
      },
    ]);
    expect(position('present-segment', { segmentId: 'child' })?.program).toEqual([
      { kind: 'call-scene', scene: { kind: 'scene', id: 'child' } },
    ]);
    const choice = position('present-choices');
    expect(choice?.frontier).toBe('decision');
    expect(choice?.control).toMatchObject({
      kind: 'choice',
      options: [{ optionId: 'choose' }],
    });
  });

  it('lowers prospective Room lifecycle Flow into prediction summaries without rejection programs', () => {
    const project = validProject();
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
    project.scenes.arrival = {
      id: 'arrival',
      label: 'Arrival',
      data: defaultSceneData('Arrival'),
    };
    project.dialogues.greeting = {
      id: 'greeting',
      label: 'Greeting',
      data: defaultDialogueData('Greeting'),
    };

    const hall = project.rooms.hall!.data;
    hall.lifecycle.afterEnter = [
      {
        id: 'project-flag',
        kind: 'set-global-property',
        variable: { $ref: { collection: 'variables', id: 'flag' } },
        value: true,
      },
      {
        id: 'branch',
        kind: 'if',
        condition: {
          kind: 'variable-comparison',
          variable: { $ref: { collection: 'variables', id: 'flag' } },
          operator: 'truthy',
        },
        // oxlint-disable-next-line unicorn/no-thenable -- canonical authored Gameplay Command field.
        then: [
          {
            id: 'arrival-scene',
            kind: 'call-scene',
            scene: { $ref: { collection: 'scenes', id: 'arrival' } },
          },
        ],
        else: [
          {
            id: 'greeting-dialogue',
            kind: 'call-dialogue',
            dialogue: { $ref: { collection: 'dialogues', id: 'greeting' } },
          },
        ],
      },
    ];
    hall.lifecycle.onEnterRejected = [
      {
        id: 'rejected-dialogue',
        kind: 'call-dialogue',
        dialogue: { $ref: { collection: 'dialogues', id: 'greeting' } },
      },
    ];
    hall.scriptHooks = [
      {
        hook: 'after-enter',
        handler: {
          module: { $ref: { collection: 'scripts', id: 'bootstrap' } },
          export: 'after_enter',
        },
      },
    ];

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prediction = result.project.flowPrediction;
    expect(prediction).toBeDefined();
    const afterEnter = prediction!.slices.find(
      (slice) =>
        slice.point.kind === 'room-lifecycle' &&
        slice.point.room.id === 'hall' &&
        slice.point.stage === 'after-enter',
    );
    expect(afterEnter?.program).toEqual([
      {
        commandId: 'project-flag',
        kind: 'set-global-property',
        property: { kind: 'property', id: 'flag' },
        value: true,
      },
      {
        commandId: 'branch',
        kind: 'if',
        condition: {
          kind: 'global-property-comparison',
          property: { kind: 'property', id: 'flag' },
          operator: 'truthy',
        },
        thenCommands: [
          {
            commandId: 'arrival-scene',
            kind: 'call-scene',
            scene: { kind: 'scene', id: 'arrival' },
          },
        ],
        elseCommands: [
          {
            commandId: 'greeting-dialogue',
            kind: 'call-dialogue',
            dialogue: { kind: 'dialogue', id: 'greeting' },
          },
        ],
      },
      { kind: 'opaque' },
    ]);
    expect(
      prediction!.slices.some(
        (slice) =>
          slice.point.kind === 'room-lifecycle' &&
          !['before-leave', 'before-enter', 'presentation', 'after-leave', 'after-enter'].includes(
            slice.point.stage,
          ),
      ),
    ).toBe(false);
  });

  it('lowers resident Interaction programs into distinct prediction points', () => {
    const project = validProject();
    project.layouts.actions = {
      id: 'actions',
      label: 'Actions',
      data: defaultLayoutData('Actions'),
    };
    project.settings.interaction = {
      defaultVerbMenuLayout: { $ref: { collection: 'layouts', id: 'actions' } },
    };
    project.scenes.inspect = {
      id: 'inspect',
      label: 'Inspect',
      data: defaultSceneData('Inspect'),
    };
    const verb = defaultVerbData('Inspect');
    verb.defaultProgram = {
      instructions: [],
      completion: { kind: 'scene', id: 'inspect' },
      outcome: 'handled',
    };
    project.verbs.inspect = { id: 'inspect', label: 'Inspect', data: verb };
    const interaction = defaultInteractionData();
    interaction.rules = [
      {
        id: 'inspect-room',
        verb: { $ref: { collection: 'verbs', id: 'inspect' } },
        slots: [],
        offer: null,
        guard: { kind: 'always' },
        priority: 0,
        program: {
          instructions: [
            {
              id: 'inspect-scene',
              kind: 'call-scene',
              scene: { $ref: { collection: 'scenes', id: 'inspect' } },
            },
          ],
          completion: { kind: 'return' },
          outcome: 'handled',
        },
      },
    ];
    project.interactions.inspect = { id: 'inspect', label: 'Inspect', data: interaction };

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prediction = result.project.flowPrediction;
    expect(prediction).toBeDefined();
    expect(
      prediction!.slices.find(
        (slice) =>
          slice.point.kind === 'interaction-rule' &&
          slice.point.interaction.id === 'inspect' &&
          slice.point.ruleId === 'inspect-room',
      )?.program,
    ).toEqual([
      {
        commandId: 'inspect-scene',
        kind: 'call-scene',
        scene: { kind: 'scene', id: 'inspect' },
      },
    ]);
    expect(
      prediction!.slices.find(
        (slice) => slice.point.kind === 'verb-default' && slice.point.verb.id === 'inspect',
      )?.program,
    ).toEqual([{ kind: 'call-scene', scene: { kind: 'scene', id: 'inspect' } }]);
    expect(
      prediction!.slices.some(
        (slice) => slice.point.kind === 'resident-layout' && slice.point.layout.id === 'actions',
      ),
    ).toBe(true);
  });

  it('compiles the implicit Project Inventory and default Inventory Layout', () => {
    const project = validProject();
    project.interactables.coin = {
      id: 'coin',
      label: 'Coin',
      data: defaultInteractableData('Coin'),
    };
    project.interactableInstances.coin = defaultInteractableInstanceData('coin', 'coin', {
      kind: 'inventory',
      inventory: { owner: { kind: 'project' }, inventoryId: 'inventory' },
    });
    project.layouts.inventory = {
      id: 'inventory',
      label: 'Inventory',
      data: defaultLayoutData('Inventory'),
    };
    project.settings.inventory = {
      defaultLayout: { $ref: { collection: 'layouts', id: 'inventory' } },
    };

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.settings.inventory).toEqual({
      playerInventory: null,
      defaultLayout: { kind: 'layout', id: 'inventory' },
    });
    expect(result.project.inventories).toEqual([{ id: 'player', label: 'Player Inventory' }]);
    expect(result.project.interactableInstances).toContainEqual(
      expect.objectContaining({
        id: 'coin',
        location: {
          kind: 'inventory',
          inventory: { owner: { kind: 'project' }, inventoryId: 'player' },
        },
      }),
    );
  });

  it('lowers the complete reusable Subject Selector vocabulary without positional rewriting', () => {
    const selectors = [
      { kind: 'any-subject' as const },
      { kind: 'family' as const, family: 'feature' as const },
      {
        kind: 'trait' as const,
        trait: { $ref: { collection: 'traits' as const, id: 'portable' } },
      },
      {
        kind: 'interactable-definition' as const,
        interactableDefinition: { $ref: { collection: 'interactables' as const, id: 'key' } },
      },
      {
        kind: 'interactable-feature' as const,
        interactableDefinition: { $ref: { collection: 'interactables' as const, id: 'key' } },
        featureId: 'lock',
      },
      { kind: 'qualified-pattern' as const, family: 'interactable' as const, pattern: 'runtime-*' },
      {
        kind: 'exact' as const,
        subject: {
          kind: 'interactable' as const,
          interactable: { $ref: { registry: 'interactableInstances' as const, id: 'key' } },
        },
      },
    ];

    expect(selectors.map(compileSubjectSelector)).toEqual([
      { kind: 'any-subject' },
      { kind: 'family', family: 'feature' },
      { kind: 'trait', trait: { kind: 'trait', id: 'portable' } },
      {
        kind: 'interactable-definition',
        interactableDefinition: { kind: 'interactable-definition', id: 'key' },
      },
      {
        kind: 'interactable-feature',
        interactableDefinition: { kind: 'interactable-definition', id: 'key' },
        featureId: 'lock',
      },
      { kind: 'qualified-pattern', family: 'interactable', pattern: 'runtime-*' },
      {
        kind: 'exact',
        subject: { kind: 'interactable', interactable: { kind: 'interactable', id: 'key' } },
      },
    ]);
  });

  it('normalizes a detached input and publishes only a strict, canonical complete project', () => {
    const project = validProject();
    const before = JSON.stringify(project);

    const result = compileAuthoringProject(project);

    expect(JSON.stringify(project)).toBe(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.canonicalJson)).toEqual(result.project);
    expect(result.diagnostics).toEqual([]);
    expect(result.stages).toEqual([
      { name: 'normalize', status: 'completed' },
      { name: 'semantic-validation', status: 'completed' },
      { name: 'link', status: 'completed' },
      { name: 'lower', status: 'completed' },
      { name: 'collect-resources', status: 'completed' },
      { name: 'assemble', status: 'completed' },
      { name: 'validate-wire', status: 'completed' },
      { name: 'serialize', status: 'completed' },
    ]);
  });

  it('rejects unattached Interactable Archetypes whose effective hotspot presentation requires a missing sprite', () => {
    const project = validProject();
    project.archetypes['invalid-interactable'] = {
      id: 'invalid-interactable',
      label: 'Invalid Interactable',
      data: {
        ...defaultArchetypeData('interactable'),
        overrides: {
          '/data/presentation/hotspots': {
            kind: 'sprite-alpha',
            hotspot: defaultHotspotBehavior('Invalid Interactable'),
          },
        },
      },
    };
    project.archetypes['invalid-custom-interactable'] = {
      id: 'invalid-custom-interactable',
      label: 'Invalid Custom Interactable',
      data: {
        ...defaultArchetypeData('interactable'),
        overrides: {
          '/data/presentation/hotspots': {
            kind: 'custom',
            hotspots: [
              {
                ...defaultHotspotBehavior('Invalid Custom Interactable'),
                shape: {
                  kind: 'rect',
                  bounds: { x: 0, y: 0, width: 1, height: 1 },
                },
              },
            ],
          },
        },
      },
    };

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'AUTHORING_HOTSPOT_AUTHORING_SOURCE_IMAGE_REQUIRED',
          jsonPointer:
            '/archetypes/invalid-interactable/data/effectiveConfiguration/data/presentation/hotspots/kind',
        }),
        expect.objectContaining({
          severity: 'error',
          code: 'AUTHORING_HOTSPOT_AUTHORING_SOURCE_IMAGE_REQUIRED',
          jsonPointer:
            '/archetypes/invalid-custom-interactable/data/effectiveConfiguration/data/presentation/hotspots/kind',
        }),
      ]),
    );
  });

  it('lowers typed Layout contracts deterministically without emitting empty contracts', () => {
    const project = validProject();
    const empty = defaultLayoutData('Empty', 'document');
    empty.contract = { inputs: {}, signals: {} };
    const contracted = defaultLayoutData('Contracted', 'document');
    contracted.contract = {
      inputs: {
        display_title: { type: 'string', nullable: false, defaultValue: 'Untitled' },
        item_count: { type: 'integer', nullable: false },
      },
      signals: {
        item_selected: {
          fields: {
            was_accepted: { type: 'boolean', nullable: false, required: true },
          },
        },
      },
      state: {
        type: 'object',
        nullable: false,
        fields: {
          page_index: { required: true, shape: { type: 'integer', nullable: false } },
        },
        defaultValue: { page_index: 1 },
      },
    };
    project.layouts.empty = { id: 'empty', label: 'Empty', data: empty };
    project.layouts.contracted = { id: 'contracted', label: 'Contracted', data: contracted };

    const result = compileAuthoringProject(project);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const emptyLayout = result.project.resources.layouts.find((layout) => layout.id === 'empty');
    const contractedLayout = result.project.resources.layouts.find(
      (layout) => layout.id === 'contracted',
    );
    expect(emptyLayout).not.toHaveProperty('contract');
    expect(contractedLayout?.contract).toEqual({
      inputs: [
        {
          id: 'display_title',
          type: 'string',
          nullable: false,
          hasDefault: true,
          defaultValue: 'Untitled',
        },
        {
          id: 'item_count',
          type: 'integer',
          nullable: false,
          hasDefault: false,
          defaultValue: null,
        },
      ],
      signals: [
        {
          id: 'item_selected',
          fields: [{ id: 'was_accepted', type: 'boolean', nullable: false, required: true }],
        },
      ],
      state: {
        type: 'object',
        nullable: false,
        hasDefault: true,
        defaultValue: { page_index: 1 },
        fields: [
          {
            id: 'page_index',
            required: true,
            shape: {
              type: 'integer',
              nullable: false,
              hasDefault: false,
              defaultValue: null,
            },
          },
        ],
      },
    });
  });

  it('derives a deterministic Save Contract from persistent executable structure only', () => {
    const baseline = compileAuthoringProject(validProject());
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    expect(baseline.project.saveContract).toMatch(/^sc1:[0-9a-f]{32}$/u);

    const metadataOnly = validProject();
    metadataOnly.project.name = 'Renamed Project';
    metadataOnly.project.description = 'Changed display metadata';
    const renamed = compileAuthoringProject(metadataOnly);
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.project.saveContract).toBe(baseline.project.saveContract);

    const stateShapeChange = validProject();
    const statefulLayout = defaultLayoutData('Stateful', 'document');
    statefulLayout.contract.state = {
      type: 'integer',
      nullable: false,
      defaultValue: 1,
    };
    stateShapeChange.layouts.stateful = {
      id: 'stateful',
      label: 'Stateful',
      data: statefulLayout,
    };
    const stateChanged = compileAuthoringProject(stateShapeChange);
    expect(stateChanged.ok).toBe(true);
    if (!stateChanged.ok) return;
    expect(stateChanged.project.saveContract).not.toBe(baseline.project.saveContract);

    const executableChange = validProject();
    executableChange.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'return { contract_changed = true }\n',
    };
    const changed = compileAuthoringProject(executableChange);
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.project.saveContract).not.toBe(baseline.project.saveContract);
  });

  it('lowers every shared definition without flattening inheritance or retaining editor metadata', () => {
    const project = validProject();
    project.editor = {
      ...project.editor,
      tags: { records: { favorite: { name: 'Favorite', color: '#ff0000', sortKey: '1' } } },
      recordMetadata: { rooms: { foyer: { tags: ['favorite'], color: '#ff0000', sortKey: '1' } } },
    };
    project.variables.visited = {
      id: 'visited',
      label: 'Visited',
      description: 'Editor-only label',
      data: defaultVariableData('boolean'),
    };
    project.assets.hero = {
      id: 'hero',
      label: 'Hero sprite',
      description: 'Import metadata is tooling-only',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/hero.png',
        aliases: ['hero.sprite'],
        contentHash: 'abc',
        sampling: 'nearest',
        imageMetadata: { width: 640, height: 960, hasAlpha: true, orientation: 1 },
      }),
    };
    project.layouts.hud = { id: 'hud', label: 'HUD', data: defaultLayoutData('HUD', 'document') };

    const baseRoom = project.rooms.foyer!;
    baseRoom.localProperties = [
      {
        id: 'mood',
        label: 'Mood',
        description: 'Current mood',
        type: 'enum',
        nullable: false,
        enumValues: ['calm', 'tense'],
        value: 'calm',
      },
    ];
    project.traits['tense-room'] = {
      id: 'tense-room',
      label: 'Tense Room',
      ownerKinds: ['room'],
      properties: [{ id: 'mood', type: 'string', nullable: false, defaultValue: 'tense' }],
    };
    project.rooms.hall = {
      ...project.rooms.hall!,
      traits: ['tense-room'],
    };
    const character = defaultCharacterData('Hero');
    character.profiles[0]!.poses[0]!.layers[0]!.sprite = {
      $ref: { collection: 'assets', id: 'hero' },
    };
    project.characters.hero = {
      id: 'hero',
      label: 'Hero',
      description: 'Tooling description',
      data: character,
    };
    const key = defaultInteractableData('Key');
    key.presentation.hotspots = { kind: 'custom', hotspots: [] };
    project.interactables.key = { id: 'key', label: 'Key', data: key };
    project.verbs.look = { id: 'look', label: 'Look', data: defaultVerbData('Look') };
    project.interactions.look = { id: 'look', label: 'Look rules', data: defaultInteractionData() };
    project.maps.house = { id: 'house', label: 'House', data: defaultMapData() };
    project.scenes.opening = { id: 'opening', label: 'Opening', data: defaultSceneData('Opening') };
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: defaultDialogueData('Intro') };
    project.scripts.bootstrap!.data = {
      kind: 'script-module',
      source: { kind: 'inline-lua', source: 'bootstrap()\nreturn {}\n' },
    };
    project.localization.messages['018f4f8c-9b5d-7ae2-9b36-4c8af613f001'] = {
      kind: 'named',
      key: 'common.greeting',
      source: 'Hello',
    };

    const result = lowerSharedAuthoringProject(project);

    expect(result.diagnostics).toEqual([]);
    expect(result.draft).toBeDefined();
    const draft = result.draft!;
    expect(draft.definitions.rooms.map((room) => room.id)).toEqual(['foyer', 'hall']);
    expect(draft.traits).toEqual([
      {
        id: 'tense-room',
        label: 'Tense Room',
        description: '',
        ownerKinds: ['room'],
        properties: [
          {
            id: 'mood',
            label: 'mood',
            description: '',
            type: 'string',
            nullable: false,
            enumValues: [],
            defaultValue: 'tense',
          },
        ],
      },
    ]);
    expect(draft.definitions.rooms[1]).toMatchObject({
      id: 'hall',
      traits: ['tense-room'],
      propertyAssignments: [],
    });
    expect(draft.definitions.characters[0]?.profiles[0]?.poses[0]?.layers[0]?.sprite).toEqual({
      kind: 'asset',
      id: 'hero',
    });
    expect(draft.properties).toEqual([
      expect.objectContaining({
        id: 'mood',
        scope: 'identity',
        owner: { kind: 'room', room: { kind: 'room', id: 'foyer' } },
        enumValues: ['calm', 'tense'],
      }),
      expect.objectContaining({
        id: 'mood',
        scope: 'identity',
        owner: { kind: 'room', room: { kind: 'room', id: 'hall' } },
        type: 'string',
        enumValues: [],
      }),
      expect.objectContaining({
        id: 'visited',
        scope: 'global',
        type: 'boolean',
        defaultValue: false,
        enumValues: [],
      }),
    ]);
    expect(draft.resources.assets).toEqual([
      {
        id: 'hero',
        kind: 'image',
        path: 'assets/images/hero.png',
        aliases: ['hero.sprite'],
        sampling: 'nearest',
        width: 640,
        height: 960,
      },
    ]);
    expect(draft.localization.catalogs).toHaveLength(1);
    expect(draft.localization.catalogs[0]?.locale).toBe('en');
    expect(draft.localization.catalogs[0]?.entries.map((entry) => entry.value)).toEqual(
      expect.arrayContaining(['Hello', 'Hero', 'Key', 'Opening', 'Intro']),
    );
    expect(draft.localization).toMatchObject({
      sourceLocale: 'en',
      defaultLocale: 'en',
      locales: [{ locale: 'en', parentLocale: null, supported: true }],
    });
    expect(JSON.stringify(draft)).not.toContain('selection');
    expect(JSON.stringify(draft)).not.toContain('Tooling description');
    expect(JSON.stringify(draft)).not.toContain('Import metadata');
    expect(JSON.stringify(draft)).not.toContain('objects');
    expect(Object.keys(draft.definitions)).not.toContain('actions');
  });

  it('publishes explicit linear sampling for default image assets', () => {
    const project = validProject();
    project.assets.media = {
      id: 'media',
      label: 'Media',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/media.png',
        contentHash: 'hash',
        imageMetadata: { width: 320, height: 180, hasAlpha: true, orientation: 1 },
      }),
    };

    const result = lowerSharedAuthoringProject(project);

    expect(result.diagnostics).toEqual([]);
    expect(result.draft?.resources.assets).toEqual([
      {
        id: 'media',
        kind: 'image',
        path: 'assets/media.png',
        aliases: [],
        sampling: 'linear',
        width: 320,
        height: 180,
      },
    ]);
  });

  it('compiles locale-specific Asset realizations onto the semantic base Asset', () => {
    const project = validProject();
    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    project.assets.media = {
      id: 'media',
      label: 'Media',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/media.png',
        contentHash: 'base-hash',
        imageMetadata: { width: 320, height: 180, hasAlpha: true, orientation: 1 },
      }),
    };
    project.assets['media-fr'] = {
      id: 'media-fr',
      label: 'Media FR',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/media-fr.png',
        contentHash: 'fr-hash',
        imageMetadata: { width: 320, height: 180, hasAlpha: true, orientation: 1 },
      }),
    };
    project.localization.assets.fr = {
      media: createLocalizedAssetVariant(project, 'media', 'media-fr')!,
      'media-fr': { useSource: true },
    };

    const result = lowerSharedAuthoringProject(project);

    expect(result.diagnostics).toEqual([]);
    expect(result.draft?.resources.assets.find((asset) => asset.id === 'media')).toMatchObject({
      id: 'media',
      localized: [
        {
          locale: 'fr',
          state: 'variant',
          asset: { kind: 'asset', id: 'media-fr' },
        },
      ],
    });
    expect(result.draft?.resources.assets.find((asset) => asset.id === 'media-fr')).toMatchObject({
      localized: [{ locale: 'fr', state: 'source' }],
    });
  });

  it('lowers every Scene instruction and ordered Room lifecycle hook without comments or disabled steps', () => {
    const project = validProject();
    project.assets.media = {
      id: 'media',
      label: 'Media',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/media.png',
        aliases: [],
        contentHash: 'hash',
        imageMetadata: { width: 320, height: 180, hasAlpha: true, orientation: 1 },
      }),
    };
    project.layouts.hud = { id: 'hud', label: 'HUD', data: defaultLayoutData('HUD', 'document') };
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
    project.characters.hero = { id: 'hero', label: 'Hero', data: defaultCharacterData('Hero') };
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: defaultDialogueData('Intro') };
    const scene = defaultSceneData('Opening');
    scene.events = [
      {
        ...defaultSceneStep('set-background'),
        id: 'background',
        asset: { $ref: { collection: 'assets', id: 'media' } },
      },
      {
        ...defaultSceneStep('actor-cue'),
        id: 'actor',
        character: { $ref: { collection: 'characters', id: 'hero' } },
        poseId: 'default',
        expressionId: 'neutral',
      },
      {
        ...defaultSceneStep('call-dialogue'),
        id: 'dialogue',
        dialogue: { $ref: { collection: 'dialogues', id: 'intro' } },
        startBlockId: 'start',
      },
      { ...defaultSceneStep('resume-dialogue'), id: 'resume-dialogue' },
      { ...defaultSceneStep('show-text'), id: 'text' },
      {
        ...defaultSceneStep('audio-cue'),
        id: 'audio',
        asset: { $ref: { collection: 'assets', id: 'media' } },
      },
      {
        ...defaultSceneStep('set-variable'),
        id: 'variable',
        variable: { $ref: { collection: 'variables', id: 'flag' } },
        value: true,
      },
      { ...defaultSceneStep('run-lua'), id: 'lua' },
      { ...defaultSceneStep('wait'), id: 'duration' },
      {
        id: 'input',
        label: 'input',
        enabled: true,
        type: 'wait',
        timeline: { trackId: 'main', startMs: 0, durationMs: 0 },
        completionDependencies: [],
        waitKind: 'input',
        skippable: false,
      },
      {
        ...defaultSceneStep('conditional-branch'),
        id: 'branch',
        branches: [{ id: 'yes', condition: { kind: 'always' }, targetStepId: 'layout' }],
        fallbackStepId: 'transition',
      },
      {
        ...defaultSceneStep('choice'),
        id: 'choice',
        options: [
          {
            id: 'continue',
            label: { source: { kind: 'inline', text: 'Continue' }, markup: 'plain' },
            effects: [
              {
                id: 'set-flag',
                kind: 'set-global-property',
                variable: { $ref: { collection: 'variables', id: 'flag' } },
                value: true,
              },
            ],
            targetStepId: 'layout',
          },
        ],
      },
      {
        ...defaultSceneStep('set-layout'),
        id: 'layout',
        layout: { $ref: { collection: 'layouts', id: 'hud' } },
      },
      { ...defaultSceneStep('transition-group'), id: 'transition' },
      { ...defaultSceneStep('show-text'), id: 'disabled', enabled: false },
      { ...defaultSceneStep('comment'), id: 'note' },
    ];
    scene.terminal = { kind: 'release-to-exploration' };
    project.scenes.opening = { id: 'opening', label: 'Opening', data: scene };
    const room = project.rooms.foyer!.data;
    room.scriptHooks = [
      {
        hook: 'before-enter',
        handler: {
          module: { $ref: { collection: 'scripts', id: 'bootstrap' } },
          export: 'before_enter',
        },
      },
      {
        hook: 'after-enter',
        handler: {
          module: { $ref: { collection: 'scripts', id: 'bootstrap' } },
          export: 'after_enter',
        },
      },
    ];

    const shared = lowerSharedAuthoringProject(project);
    expect(shared.diagnostics).toEqual([]);
    const result = lowerSceneAndRoomPrograms(project, shared.draft!);
    expect(result.diagnostics).toEqual([]);
    const lowered = result.draft!;
    expect(
      lowered.definitions.scenes[0]!.program.events.map((event) => event.instruction.kind),
    ).toEqual([
      'set-background',
      'actor-cue',
      'call-dialogue',
      'resume-dialogue',
      'show-text',
      'audio-cue',
      'gameplay-effect-batch',
      'run-lua',
      'wait-duration',
      'wait-input',
      'conditional-branch',
      'choice',
      'set-layout',
      'transition-group',
    ]);
    expect(lowered.definitions.scenes[0]!.program.events[6]!.instruction).toEqual({
      id: 'variable',
      kind: 'gameplay-effect-batch',
      operations: [
        {
          id: 'variable',
          kind: 'set-global-property',
          property: { kind: 'property', id: 'flag' },
          value: true,
        },
      ],
    });
    expect(lowered.definitions.scenes[0]!.terminal).toEqual({ kind: 'release-to-exploration' });
    expect(
      lowered.definitions.rooms.find((candidate) => candidate.id === 'foyer')!.scriptHooks,
    ).toEqual([
      {
        hook: 'before-enter',
        handler: { module: { kind: 'script', id: 'bootstrap' }, export: 'before_enter' },
      },
      {
        hook: 'after-enter',
        handler: { module: { kind: 'script', id: 'bootstrap' }, export: 'after_enter' },
      },
    ]);
  });

  it('rejects Scene targets removed from runtime lowering and unresolved instruction-local nested references', () => {
    const project = validProject();
    project.characters.hero = { id: 'hero', label: 'Hero', data: defaultCharacterData('Hero') };
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: defaultDialogueData('Intro') };
    const scene = defaultSceneData('Broken');
    scene.events = [
      {
        ...defaultSceneStep('conditional-branch'),
        id: 'branch',
        branches: [],
        fallbackStepId: 'note',
      },
      {
        ...defaultSceneStep('actor-cue'),
        id: 'actor',
        character: { $ref: { collection: 'characters', id: 'hero' } },
        poseId: 'missing',
        expressionId: 'missing',
      },
      {
        ...defaultSceneStep('call-dialogue'),
        id: 'dialogue',
        dialogue: { $ref: { collection: 'dialogues', id: 'intro' } },
        startBlockId: 'missing',
      },
      { ...defaultSceneStep('comment'), id: 'note' },
    ];
    project.scenes.broken = { id: 'broken', label: 'Broken', data: scene };
    const shared = lowerSharedAuthoringProject(project);
    const result = lowerSceneAndRoomPrograms(project, shared.draft!);
    expect(result.draft).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'COMPILER_SCENE_TARGET_NOT_EXECUTABLE',
      'COMPILER_SCENE_POSE_MISSING',
      'COMPILER_SCENE_EXPRESSION_MISSING',
      'COMPILER_SCENE_DIALOGUE_BLOCK_MISSING',
    ]);
  });

  it('rejects type-invalid variable conditions before Scene and Room lowering', () => {
    const project = validProject();
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
    const scene = defaultSceneData('Typed Scene');
    scene.events = [
      {
        ...defaultSceneStep('show-text'),
        id: 'typed-text',
        condition: {
          kind: 'variable-comparison',
          variable: { $ref: { collection: 'variables', id: 'flag' } },
          operator: 'equal',
          value: 'not-a-boolean',
        },
      },
    ];
    project.scenes.typed = { id: 'typed', label: 'Typed', data: scene };
    project.rooms.foyer!.data.lifecycle.canEnter = {
      kind: 'variable-comparison',
      variable: { $ref: { collection: 'variables', id: 'flag' } },
      operator: 'equal',
      value: 'not-a-boolean',
    };

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        jsonPointer: '/rooms/foyer/data/lifecycle/canEnter/value',
        message: "Value does not match variable 'flag'.",
      }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        jsonPointer: '/scenes/typed/data/events/0/condition/value',
        message: "Value does not match variable 'flag'.",
      }),
    );
    expect(result.stages.find((stage) => stage.name === 'semantic-validation')).toEqual({
      name: 'semantic-validation',
      status: 'failed',
    });
  });

  it('losslessly lowers Dialogue graphs, Interaction instructions and retained Verb fallback chains', () => {
    const project = validProject();
    project.assets.voice = {
      id: 'voice',
      label: 'Voice',
      data: assetDataFromImportMetadata({
        kind: 'audio',
        projectRelativePath: 'assets/audio/voice.ogg',
        extension: '.ogg',
        byteSize: 10,
        contentHash: 'voice-hash',
        importedAt: '2026-01-01T00:00:00.000Z',
        originalName: 'voice.ogg',
        originalPath: '/tmp/voice.ogg',
        imageMetadata: null,
      }),
    };
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
    const key = defaultInteractableData('Key');
    key.presentation.hotspots = { kind: 'custom', hotspots: [] };
    project.interactables.key = { id: 'key', label: 'Key', data: key };
    project.rooms.foyer!.data.placements = [
      {
        id: 'key-place',
        bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
        presentation: { label: null, layout: null },
      },
    ];
    project.scenes.opening = { id: 'opening', label: 'Opening', data: defaultSceneData('Opening') };
    const dialogue = defaultDialogueData('Intro');
    dialogue.blocks = [
      {
        ...defaultDialogueBlock('sequence', 'start'),
        segments: [
          {
            ...defaultDialogueSegment('line', 'welcome'),
            text: {
              source: { kind: 'inline', text: 'Hello' },
              markup: 'active-text',
            },
            cues: [
              {
                id: 'bold-open',
                kind: 'active-text',
                position: { offset: 0, order: 0 },
                token: '[b]',
              },
              {
                id: 'expression',
                kind: 'speaker-expression',
                position: { offset: 2, order: 0 },
                expressionId: 'neutral',
              },
              {
                id: 'voice',
                kind: 'voice',
                position: { offset: 3, order: 0 },
                asset: { $ref: { collection: 'assets', id: 'voice' } },
                pausePolicy: 'gameplay',
                gain: 0.8,
                pan: -0.2,
                waitForCompletion: true,
                skipBehavior: 'stop',
              },
              {
                id: 'sfx',
                kind: 'sound-effect',
                position: { offset: 3, order: 1 },
                asset: { $ref: { collection: 'assets', id: 'voice' } },
                pausePolicy: 'owner',
                gain: 0.5,
                pan: 0.25,
                waitForCompletion: false,
                causality: 'disposable',
                synchronized: false,
                skipBehavior: 'suppress',
              },
              {
                id: 'camera',
                kind: 'camera',
                position: { offset: 4, order: 0 },
                emphasis: {
                  kind: 'flash',
                  color: '#ffffff',
                  opacity: 0.75,
                  durationMs: 120,
                  skippable: true,
                  waitForCompletion: false,
                },
              },
              {
                id: 'bold-close',
                kind: 'active-text',
                position: { offset: 5, order: 0 },
                token: '[/b]',
              },
            ],
            effects: [
              {
                id: 'dialogue-line-effect',
                kind: 'set-global-property',
                variable: { $ref: { collection: 'variables', id: 'flag' } },
                value: true,
              },
            ],
            showOnce: true,
            logged: false,
            autosaveSafePoint: true,
          },
          {
            ...defaultDialogueSegment('run-lua', 'script'),
            condition: { kind: 'always' },
            mayYield: true,
          },
          {
            ...defaultDialogueSegment('call-scene', 'child-scene'),
            scene: { $ref: { collection: 'scenes', id: 'opening' } },
            inputs: [],
            uiPolicy: 'preserve',
            condition: { kind: 'always' },
          },
          {
            ...defaultDialogueSegment('handoff', 'handoff'),
            condition: { kind: 'always' },
            payload: 'resume-token',
          },
          { ...defaultDialogueSegment('comment', 'note') },
        ],
      },
      defaultDialogueBlock('choice', 'choice'),
      { ...defaultDialogueBlock('redirect', 'redirect'), targetBlockId: 'start' },
      defaultDialogueBlock('comment', 'comment'),
    ];
    dialogue.edges = [
      { id: 'next', kind: 'next', fromBlockId: 'start', toBlockId: 'choice' },
      {
        id: 'choose',
        kind: 'choice',
        fromBlockId: 'choice',
        toBlockId: 'redirect',
        label: { source: { kind: 'inline', text: 'Again' }, markup: 'plain' },
        condition: { kind: 'always' },
        effects: [{ id: 'choice-effect', kind: 'run-lua', source: 'again()' }],
        logged: true,
        autosaveSafePoint: true,
      },
    ];
    dialogue.completion = { kind: 'scene', id: 'opening' };
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: dialogue };

    const baseVerb = defaultVerbData('Use');
    const targetText = {
      source: { kind: 'inline' as const, text: 'target' },
      markup: 'plain' as const,
    };
    baseVerb.slots = [
      {
        id: 'target',
        label: targetText,
        prompt: targetText,
        selectors: [{ kind: 'any-subject' }],
      },
    ];
    baseVerb.bindingOrder = ['target'];
    baseVerb.availability = { kind: 'lua-predicate', source: 'base_available()' };
    baseVerb.defaultProgram = {
      instructions: [
        {
          id: 'base-notify',
          kind: 'notify',
          message: { source: { kind: 'inline', text: 'Base' }, markup: 'plain' },
        },
      ],
      completion: { kind: 'return' },
      outcome: 'unhandled',
    };
    project.verbs.use = { id: 'use', label: 'Use', data: baseVerb };
    const childVerb = defaultVerbData('Unlock');
    childVerb.slots = [
      {
        id: 'target',
        label: targetText,
        prompt: targetText,
        selectors: [{ kind: 'any-subject' }],
      },
    ];
    childVerb.bindingOrder = ['target'];
    childVerb.availability = { kind: 'always' };
    childVerb.defaultProgram = {
      instructions: [
        {
          id: 'child-call',
          kind: 'call-dialogue',
          dialogue: { $ref: { collection: 'dialogues', id: 'intro' } },
        },
      ],
      completion: { kind: 'return' },
      outcome: 'handled',
    };
    project.verbs.unlock = { id: 'unlock', label: 'Unlock', data: childVerb };

    const interaction = defaultInteractionData();
    interaction.rules = [
      {
        id: 'unlock-key',
        verb: { $ref: { collection: 'verbs', id: 'unlock' } },
        slots: [
          {
            slotId: 'target',
            selectors: [
              {
                kind: 'exact',
                subject: {
                  kind: 'interactable',
                  interactable: { $ref: { registry: 'interactableInstances', id: 'key' } },
                },
              },
            ],
          },
        ],
        offer: null,
        guard: { kind: 'always' },
        priority: 20,
        program: {
          instructions: [
            {
              id: 'effect',
              kind: 'set-global-property',
              variable: { $ref: { collection: 'variables', id: 'flag' } },
              value: true,
            },
            {
              id: 'move',
              kind: 'move-instance',
              subject: {
                kind: 'interactable',
                interactable: { $ref: { registry: 'interactableInstances', id: 'key' } },
              },
              location: {
                kind: 'inventory',
                inventory: {
                  kind: 'inventory',
                  inventory: { owner: { kind: 'project' }, inventoryId: 'inventory' },
                },
              },
            },
            {
              id: 'state',
              kind: 'set-visible',
              subject: {
                kind: 'interactable',
                interactable: { $ref: { registry: 'interactableInstances', id: 'key' } },
              },
              visible: false,
            },
            {
              id: 'notify',
              kind: 'notify',
              message: { source: { kind: 'inline', text: 'Unlocked' }, markup: 'plain' },
            },
          ],
          completion: { kind: 'return' },
          outcome: 'handled',
        },
      },
      {
        id: 'any-key',
        verb: { $ref: { collection: 'verbs', id: 'unlock' } },
        slots: [
          {
            slotId: 'target',
            selectors: [{ kind: 'family', family: 'interactable' }],
          },
        ],
        offer: null,
        guard: { kind: 'always' },
        priority: 0,
        program: defaultInteractionProgram(),
      },
    ];
    project.interactions.unlock = { id: 'unlock', label: 'Unlock', data: interaction };

    const shared = lowerSharedAuthoringProject(project).draft!;
    const sceneRoom = lowerSceneAndRoomPrograms(project, shared).draft!;
    const result = lowerDialogueAndInteractionPrograms(project, sceneRoom);
    expect(result.diagnostics).toEqual([]);
    const compiled = result.draft!;
    const loweredDialogue = compiled.definitions.dialogues[0]!;
    expect(loweredDialogue.program.blocks.map((block) => block.kind)).toEqual([
      'sequence',
      'choice',
      'redirect',
    ]);
    expect(loweredDialogue.program.blocks[0]).toMatchObject({
      segments: [
        {
          id: 'welcome',
          kind: 'line',
          text: {
            markup: 'active-text',
            source: { kind: 'message', id: expect.any(Number) },
          },
          cues: [
            {
              id: 'expression',
              kind: 'speaker-expression',
              position: { offset: 2, order: 0 },
              expressionId: 'neutral',
            },
            {
              id: 'voice',
              kind: 'voice',
              position: { offset: 3, order: 0 },
              asset: { kind: 'asset', id: 'voice' },
              pausePolicy: 'gameplay',
              gain: 0.8,
              pan: -0.2,
              waitForCompletion: true,
              skipBehavior: 'stop',
            },
            {
              id: 'sfx',
              kind: 'sound-effect',
              position: { offset: 3, order: 1 },
              asset: { kind: 'asset', id: 'voice' },
              pausePolicy: 'owner',
              gain: 0.5,
              pan: 0.25,
              waitForCompletion: false,
              causality: 'disposable',
              synchronized: false,
              skipBehavior: 'suppress',
            },
            {
              id: 'camera',
              kind: 'camera',
              position: { offset: 4, order: 0 },
              emphasis: {
                kind: 'flash',
                color: '#ffffff',
                opacity: 0.75,
                durationMs: 120,
                skippable: true,
                waitForCompletion: false,
              },
            },
          ],
        },
        { id: 'script', kind: 'run-lua' },
        {
          id: 'child-scene',
          kind: 'call-scene',
          scene: { kind: 'scene', id: 'opening' },
          inputs: [],
          uiPolicy: 'preserve',
        },
        { id: 'handoff', kind: 'handoff', payload: 'resume-token' },
      ],
    });
    expect(loweredDialogue.program.edges.map((edge) => edge.kind)).toEqual(['next', 'choice']);
    expect(loweredDialogue.completion).toEqual({
      kind: 'scene',
      scene: { kind: 'scene', id: 'opening' },
    });
    expect(
      compiled.definitions.verbs.map((verb) => ({
        id: verb.id,
        availability: verb.availability.kind,
        outcome: verb.defaultProgram.outcome,
      })),
    ).toEqual([
      { id: 'unlock', availability: 'always', outcome: 'handled' },
      { id: 'use', availability: 'lua-predicate', outcome: 'unhandled' },
    ]);
    expect(
      compiled.definitions.interactions[0]!.rules[0]!.program.instructions.map(
        (instruction) => instruction.id,
      ),
    ).toEqual(['effect', 'move', 'state', 'notify']);
    expect(
      compiled.definitions.interactions[0]!.rules.map((rule) => rule.slots[0]!.selectors[0]!.kind),
    ).toEqual(['exact', 'family']);
  });

  it('rejects type-invalid Dialogue, Interaction, and Verb variable usage before lowering', () => {
    const project = validProject();
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };

    const dialogue = defaultDialogueData('Typed Dialogue');
    dialogue.blocks = [
      {
        ...defaultDialogueBlock('sequence', 'start'),
        segments: [
          {
            ...defaultDialogueSegment('line', 'line'),
            condition: {
              kind: 'variable-comparison',
              variable: { $ref: { collection: 'variables', id: 'flag' } },
              operator: 'equal',
              value: 'not-a-boolean',
            },
          },
        ],
      },
    ];
    project.dialogues.typed = { id: 'typed', label: 'Typed', data: dialogue };

    const verb = defaultVerbData('Use');
    verb.availability = {
      kind: 'variable-comparison',
      variable: { $ref: { collection: 'variables', id: 'flag' } },
      operator: 'equal',
      value: 'not-a-boolean',
    };
    project.verbs.use = { id: 'use', label: 'Use', data: verb };

    const interaction = defaultInteractionData();
    interaction.rules = [
      {
        id: 'typed-rule',
        verb: { $ref: { collection: 'verbs', id: 'use' } },
        slots: [],
        offer: null,
        guard: {
          kind: 'variable-comparison',
          variable: { $ref: { collection: 'variables', id: 'flag' } },
          operator: 'equal',
          value: 'not-a-boolean',
        },
        priority: 0,
        program: {
          instructions: [
            {
              id: 'bad-effect',
              kind: 'set-global-property',
              variable: { $ref: { collection: 'variables', id: 'flag' } },
              value: 'not-a-boolean',
            },
          ],
          completion: { kind: 'return' },
          outcome: 'handled',
        },
      },
    ];
    project.interactions.typed = { id: 'typed', label: 'Typed', data: interaction };

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(false);
    for (const pointer of [
      '/dialogues/typed/data/blocks/0/segments/0/condition/value',
      '/interactions/typed/data/rules/0/guard/value',
      '/interactions/typed/data/rules/0/program/instructions/0/value',
      '/verbs/use/data/availability/value',
    ]) {
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          jsonPointer: pointer,
          message: "Value does not match variable 'flag'.",
        }),
      );
    }
  });

  it('produces identical specialized program drafts independently of collection map insertion order', () => {
    const buildDraft = (roomOrder: readonly string[]) => {
      const project = validProject(roomOrder);
      project.scenes.opening = {
        id: 'opening',
        label: 'Opening',
        data: defaultSceneData('Opening'),
      };
      project.dialogues.intro = { id: 'intro', label: 'Intro', data: defaultDialogueData('Intro') };
      project.verbs.look = { id: 'look', label: 'Look', data: defaultVerbData('Look') };
      project.interactions.look = { id: 'look', label: 'Look', data: defaultInteractionData() };
      const shared = lowerSharedAuthoringProject(project).draft!;
      const sceneRoom = lowerSceneAndRoomPrograms(project, shared).draft!;
      return lowerDialogueAndInteractionPrograms(project, sceneRoom).draft!;
    };

    expect(buildDraft(['foyer', 'hall'])).toEqual(buildDraft(['hall', 'foyer']));
  });

  it('requires a strict compiled entrypoint before shared lowering', () => {
    const project = validProject();
    project.entrypoint = null;
    const result = lowerSharedAuthoringProject(project);
    expect(result.draft).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'COMPILER_ENTRYPOINT_REQUIRED', path: '/entrypoint' }),
    ]);
  });

  it('compiles a newly created Interactable without requiring a sprite or hotspot', () => {
    const project = validProject();
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      data: defaultInteractableData('Key'),
    };

    const result = compileAuthoringProject(project);

    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics, null, 2)).toBe(
      true,
    );
    if (!result.ok) return;
    expect(result.project.definitions.interactables[0]?.presentation).toMatchObject({
      sprite: null,
      material: null,
      hotspots: { kind: 'none' },
    });
  });

  it('blocks compilation when Alpha hotspot mode has no sprite', () => {
    const project = validProject();
    const data = defaultInteractableData('Key');
    data.presentation.hotspots = {
      kind: 'sprite-alpha',
      hotspot: defaultHotspotBehavior('Key'),
    };
    project.interactables.key = { id: 'key', label: 'Key', data };

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'AUTHORING_HOTSPOT_AUTHORING_SOURCE_IMAGE_REQUIRED',
        severity: 'error',
        jsonPointer: '/interactables/key/data/presentation/hotspots/kind',
      }),
    );
  });

  it('lowers multiple declared Interactable Instances from one immutable definition without changing the compiled schema version', () => {
    const project = validProject();
    project.traits.quest = {
      id: 'quest',
      label: 'Quest object',
      ownerKinds: ['interactable'],
      properties: [{ id: 'polished', type: 'boolean', nullable: false }],
    };
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      data: defaultInteractableData('Key'),
      traits: [],
      defaultProperties: [
        {
          id: 'polished',
          label: 'Polished',
          description: 'Instance finish',
          type: 'boolean',
          nullable: false,
          defaultValue: false,
        },
      ],
    };
    project.interactableInstances['key-foyer'] = {
      ...defaultInteractableInstanceData('key-foyer', 'key', {
        kind: 'room',
        room: { $ref: { collection: 'rooms', id: 'foyer' } },
      }),
      editorLabel: 'Foyer key',
      traits: { add: ['quest'], remove: [] },
      localProperties: [{ id: 'polished', type: 'boolean', nullable: false, value: true }],
    };
    project.interactableInstances['key-spare'] = defaultInteractableInstanceData(
      'key-spare',
      'key',
    );
    project.interactableInstances['key-spare'].localProperties.push({
      id: 'polished',
      type: 'boolean',
      nullable: false,
      value: true,
    });

    const result = compileAuthoringProject(project);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.schemaVersion).toBe(1);
    expect(result.project.definitions.interactables).toEqual([
      {
        id: 'key',
        displayName: { markup: 'plain', source: { kind: 'message', id: 1 } },
        stackable: false,
        stackLimit: null,
        features: [],
        inventories: [],
        presentation: { sprite: null, material: null, hotspots: { kind: 'none' } },
        traits: [],
        propertyAssignments: [],
        properties: [
          {
            id: 'polished',
            label: 'Polished',
            description: 'Instance finish',
            type: 'boolean',
            nullable: false,
            enumValues: [],
            defaultValue: false,
          },
        ],
      },
    ]);
    expect(result.project.interactableInstances).toEqual([
      {
        id: 'key-foyer',
        definition: { kind: 'interactable-definition', id: 'key' },
        enabled: true,
        visible: true,
        quantity: 1,
        location: { kind: 'room', room: { kind: 'room', id: 'foyer' } },
        traitAdds: ['quest'],
        traitRemoves: [],
        propertyOverrides: [{ propertyId: 'polished', value: true }],
        localProperties: [],
        featureOverrides: [],
      },
      {
        id: 'key-spare',
        definition: { kind: 'interactable-definition', id: 'key' },
        enabled: true,
        visible: true,
        quantity: 1,
        location: { kind: 'unplaced' },
        traitAdds: [],
        traitRemoves: [],
        propertyOverrides: [{ propertyId: 'polished', value: true }],
        localProperties: [],
        featureOverrides: [],
      },
    ]);
  });

  it('lowers same-key Room Properties as independent exact-owner declarations', () => {
    const project = validProject(['foyer', 'hall']);
    project.variables.state = {
      id: 'state',
      label: 'Global state',
      data: defaultVariableData('integer'),
    };
    project.rooms.foyer!.localProperties = [
      {
        id: 'state',
        label: 'Open state',
        type: 'boolean',
        nullable: false,
        value: true,
      },
    ];
    project.rooms.hall!.localProperties = [
      {
        id: 'state',
        description: 'Unrelated textual state',
        type: 'string',
        nullable: true,
        value: null,
      },
    ];

    const result = compileAuthoringProject(project);

    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics, null, 2)).toBe(
      true,
    );
    if (!result.ok) return;
    expect(result.project.schemaVersion).toBe(1);
    expect(result.project.properties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'state',
          type: 'boolean',
          nullable: false,
          owner: { kind: 'room', room: { kind: 'room', id: 'foyer' } },
          scope: 'identity',
        }),
        expect.objectContaining({
          id: 'state',
          type: 'string',
          nullable: true,
          owner: { kind: 'room', room: { kind: 'room', id: 'hall' } },
          scope: 'identity',
        }),
        expect.objectContaining({
          id: 'state',
          type: 'integer',
          scope: 'global',
        }),
      ]),
    );
    expect(
      result.project.definitions.rooms.find((room) => room.id === 'foyer')?.propertyAssignments,
    ).toEqual([{ propertyId: 'state', value: true }]);
    expect(
      result.project.definitions.rooms.find((room) => room.id === 'hall')?.propertyAssignments,
    ).toEqual([{ propertyId: 'state', value: null }]);
  });

  it('strictly rejects invalid authoring boundary data and produces deterministic diagnostics independent of map insertion order', () => {
    const invalid = Object.assign(validProject(), { unknownWireInput: true });
    const invalidResult = compileAuthoringProject(invalid);
    expect(invalidResult.ok).toBe(false);
    expect(invalidResult.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'AUTHORING_SCHEMA_UNRECOGNIZED_KEYS' }),
    );

    const first = compileAuthoringProject(validProject(['foyer', 'hall']));
    const reordered = compileAuthoringProject(validProject(['hall', 'foyer']));
    expect(first.diagnostics).toEqual(reordered.diagnostics);
    expect(first.stages).toEqual(reordered.stages);
    expect(first.ok).toBe(true);
    expect(reordered.ok).toBe(true);
    if (first.ok && reordered.ok) expect(first.canonicalJson).toBe(reordered.canonicalJson);
  });

  it('emits typed Character idle and Room environment records only when configured', () => {
    const project = comprehensiveGoldenProject();
    const character = project.characters.hero!.data;
    character.idles = [
      {
        id: 'breathing',
        label: 'Breathing',
        kind: 'pulse',
        amplitude: 0.02,
        periodMs: 1800,
        clock: 'gameplay',
      },
    ];
    character.defaults.idleId = 'breathing';
    const room = project.rooms.start!.data;
    room.environments = [
      {
        id: 'rain',
        condition: { kind: 'always' },
        asset: { $ref: { collection: 'assets', id: 'image-main' } },
        material: { $ref: { collection: 'materials', id: 'sprite-material' } },
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        plane: 'world-overlay',
        order: 4,
        clock: 'gameplay',
        scrollPerSecond: { x: 0, y: 0.1 },
        opacity: 0.6,
        visible: true,
      },
    ];

    const result = compileAuthoringProject(project);

    expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics, null, 2)).toBe(
      true,
    );
    if (!result.ok) return;
    const compiledCharacter = result.project.definitions.characters.find(
      (value) => value.id === 'hero',
    );
    const compiledRoom = result.project.definitions.rooms.find((value) => value.id === 'start');
    expect(compiledCharacter?.defaults.idleId).toBe('breathing');
    expect(compiledCharacter?.idles).toEqual([
      {
        id: 'breathing',
        kind: 'pulse',
        amplitude: 0.02,
        periodMs: 1800,
        clock: 'gameplay',
      },
    ]);
    expect(compiledRoom?.environments).toEqual([
      expect.objectContaining({
        id: 'rain',
        plane: 'world-overlay',
        order: 4,
        clock: 'gameplay',
        scrollPerSecond: { x: 0, y: 0.1 },
        opacity: 0.6,
      }),
    ]);
  });

  it('builds shared symbols for every collection and representative nested stable-ID namespaces', () => {
    const project = validProject();
    const room = project.rooms.foyer!;
    const roomData = room.data;
    roomData.placements = [
      {
        id: 'key-placement',
        bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
        presentation: { label: null, layout: null },
      },
    ];
    project.interactables.key = { id: 'key', label: 'Key', data: defaultInteractableData('Key') };
    const scene = defaultSceneData('Opening');
    scene.events = [
      {
        ...defaultSceneStep('choice'),
        id: 'choice',
        options: [
          {
            id: 'continue',
            label: { source: { kind: 'inline', text: 'Continue' }, markup: 'plain' },
            effects: [],
            targetStepId: 'choice',
          },
        ],
      },
    ];
    project.scenes.opening = { id: 'opening', label: 'Opening', data: scene };

    const symbols = buildAuthoringSymbolTables(project);
    for (const collection of authoringCollectionKeys)
      expect(symbols.collections.has(collection)).toBe(true);
    expect(resolveAuthoringSymbol(symbols, 'rooms', 'foyer')).toEqual(project.rooms.foyer);
    expect(
      resolveNestedAuthoringSymbol(symbols, 'room-placement', 'foyer', 'key-placement')?.sourcePath,
    ).toBe('/rooms/foyer/data/placements/0');
    expect(
      resolveNestedAuthoringSymbol(symbols, 'scene-choice-option', 'opening', 'continue')
        ?.sourcePath,
    ).toBe('/scenes/opening/data/events/0/options/0');
  });

  it('indexes every declared nested stable-ID namespace', () => {
    const project = validProject();

    const character = defaultCharacterData('Hero');
    character.profiles[0]!.poses = [{ ...character.profiles[0]!.poses[0]!, id: 'standing' }];
    character.profiles[0]!.defaultPoseId = 'standing';
    character.expressions = [{ ...character.expressions[0]!, id: 'neutral' }];
    project.characters.hero = { id: 'hero', label: 'Hero', data: character };

    const room = defaultRoomData('Foyer');
    room.overlays = [
      {
        id: 'hud-overlay',
        layout: { $ref: { collection: 'layouts', id: 'hud' } },
        condition: { kind: 'always' },
        visible: true,
        order: 0,
      },
    ];
    room.placements = [
      {
        id: 'key-placement',
        bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
        presentation: { label: null, layout: null },
      },
    ];
    room.cast = [
      {
        id: 'hero-cast',
        character: { $ref: { collection: 'characters', id: 'hero' } },
        condition: { kind: 'always' },
        placementId: 'key-placement',
        poseId: 'standing',
        expressionId: 'neutral',
        idleId: null,
        visible: true,
        order: 0,
      },
    ];
    room.props = [
      {
        id: 'key-prop',
        condition: { kind: 'always' },
        placementId: 'key-placement',
        asset: null,
        material: { $ref: { collection: 'materials', id: 'material' } },
        visible: true,
        order: 0,
      },
    ];
    room.exits = [
      {
        id: 'north-exit',
        direction: 'north',
        target: { $ref: { collection: 'rooms', id: 'hall' } },
        label: 'North',
        condition: { kind: 'always' },
        onRejected: [],
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.interactables.key = { id: 'key', label: 'Key', data: defaultInteractableData('Key') };

    const scene = defaultSceneData('Opening');
    scene.events = [
      {
        ...defaultSceneStep('conditional-branch'),
        id: 'branch',
        branches: [{ id: 'true-branch', condition: { kind: 'always' }, targetStepId: 'choice' }],
        fallbackStepId: 'choice',
      },
      {
        ...defaultSceneStep('choice'),
        id: 'choice',
        options: [
          {
            id: 'continue',
            label: { source: { kind: 'inline', text: 'Continue' }, markup: 'plain' },
            effects: [],
            targetStepId: 'choice',
          },
        ],
      },
    ];
    project.scenes.opening = { id: 'opening', label: 'Opening', data: scene };

    const dialogue = defaultDialogueData('Intro');
    dialogue.blocks = [
      {
        ...defaultDialogueBlock('sequence', 'start'),
        segments: [defaultDialogueSegment('line', 'line-1')],
      },
    ];
    dialogue.edges = [{ id: 'loop', kind: 'next', fromBlockId: 'start', toBlockId: 'start' }];
    project.dialogues.intro = { id: 'intro', label: 'Intro', data: dialogue };

    const interaction = defaultInteractionData();
    interaction.rules = [
      {
        id: 'look-rule',
        verb: { $ref: { collection: 'verbs', id: 'look' } },
        slots: [],
        offer: null,
        guard: { kind: 'always' },
        priority: 0,
        program: {
          instructions: [
            {
              id: 'notice',
              kind: 'notify',
              message: { source: { kind: 'inline', text: 'Look' }, markup: 'plain' },
            },
          ],
          completion: { kind: 'return' },
          outcome: 'unhandled',
        },
      },
    ];
    project.interactions.look = { id: 'look', label: 'Look', data: interaction };

    const map = defaultMapData();
    map.locations = [
      {
        id: 'foyer-location',
        room: { $ref: { collection: 'rooms', id: 'foyer' } },
        regions: [],
        label: null,
        icon: null,
        style: null,
        labelAnchor: null,
        connectionAnchor: null,
        visibility: { kind: 'always' },
        pickOrder: 0,
        logicalOrder: 0,
      },
    ];
    map.connections = [
      {
        id: 'north-connection',
        exits: [{ room: 'foyer', exit: 'north-exit' }],
        label: null,
        icon: null,
        style: null,
        visibility: { kind: 'always' },
        logicalOrder: 0,
        path: [],
        hitRegions: [],
      },
    ];
    project.maps.house = { id: 'house', label: 'House', data: map };

    const test = defaultTestData('Smoke');
    const step = defaultTestStep('tick', 'Start');
    test.steps = [{ ...step, id: 'start' }];
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data: test };

    const symbols = buildAuthoringSymbolTables(project);
    expect([...symbols.nested.keys()].sort()).toEqual([...compilerNestedNamespaces].sort());
    for (const namespace of compilerNestedNamespaces)
      expect(symbols.nested.get(namespace)?.size).toBeGreaterThan(0);
  });
});
