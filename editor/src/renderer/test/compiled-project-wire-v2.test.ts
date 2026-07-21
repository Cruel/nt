import { describe, expect, it } from 'vite-plus/test';
import {
  compiledDiagnosticSchema,
  compiledProjectWireV2Schema,
  parseCompiledProjectWireV2,
  serializeCompiledProjectWireV2,
} from '../../shared/project-schema/compiled-project';

function representativeWireFixture() {
  return {
    schema: 'noveltea.compiled.project',
    schemaVersion: 2,
    project: {
      id: 'wire-demo',
      name: 'Wire Demo',
      version: '1.0.0',
      author: 'NovelTea',
      description: 'A decoder fixture.',
    },
    settings: {
      display: {
        referenceResolution: { width: 1920, height: 1080 },
        worldRasterPolicy: 'capped',
        barColor: '#000000',
      },
      accessibility: {
        uiScale: { enabled: true, minimum: 1, maximum: 2 },
        textScale: { enabled: true, minimum: 1, maximum: 2 },
      },
      text: { defaultFont: null },
      titleScreen: {
        titleImage: null,
        showProjectTitle: true,
        showAuthor: false,
        subtitle: '',
        startLabel: 'Start',
      },
      systemLayouts: [{ role: 'game-hud', layout: { kind: 'layout', id: 'hud' } }],
      roomNavigationTransition: { kind: 'cut', durationMs: 0, color: null, skippable: true },
    },
    startupHook: { source: 'bootstrap()' },
    entrypoint: { kind: 'room', room: { kind: 'room', id: 'foyer' } },
    properties: [
      {
        id: 'mood',
        label: 'Mood',
        description: 'The current mood.',
        type: 'enum',
        nullable: false,
        defaultValue: 'calm',
        enumValues: ['calm', 'tense'],
        ownerKinds: ['room'],
        persistence: 'Save',
      },
    ],
    variables: [{ id: 'visited', type: 'boolean', defaultValue: false, enumValues: [] }],
    localization: {
      defaultLocale: 'en',
      fallbackLocale: null,
      catalogs: [{ locale: 'en', entries: [{ key: 'foyer-title', value: 'Foyer' }] }],
    },
    resources: {
      assets: [
        {
          id: 'foyer-image',
          kind: 'image',
          path: 'images/foyer.png',
          aliases: ['foyer.background'],
        },
      ],
      layouts: [
        {
          id: 'hud',
          kind: 'document',
          target: 'default-ui',
          rml: { kind: 'inline', text: '<rml><body/></rml>' },
          rcss: { kind: 'inline', text: '' },
          lua: { kind: 'inline', text: '' },
          script: { enabled: false, namespace: null },
          scalePolicy: { ui: 'inherit', text: 'inherit' },
          mount: { defaultParent: null, scopedStyles: true },
          dependencies: { images: [], fonts: [], stylesheets: [], materials: [], scripts: [] },
        },
      ],
      scripts: [{ id: 'bootstrap', source: { kind: 'inline-lua', source: 'return true' } }],
    },
    definitions: {
      characters: [
        {
          id: 'hero',
          extends: null,
          propertyAssignments: [],
          displayName: 'Hero',
          dialogue: { name: 'Hero', nameColor: null, textColor: null, styleClass: '' },
          defaults: { poseId: 'default', expressionId: 'neutral' },
          poses: [
            {
              id: 'default',
              sprite: null,
              material: null,
              offset: { x: 0, y: 0 },
              scale: 1,
              anchor: { x: 0.5, y: 1 },
            },
          ],
          expressions: [{ id: 'neutral', poseId: null, sprite: null, material: null }],
          initialWorldState: { location: { kind: 'nowhere' }, enabled: true, visible: true },
        },
      ],
      rooms: [
        {
          id: 'foyer',
          extends: null,
          propertyAssignments: [{ propertyId: 'mood', value: 'calm' }],
          displayName: 'Foyer',
          background: {
            asset: { kind: 'asset', id: 'foyer-image' },
            material: null,
            fit: 'cover',
            color: null,
          },
          description: { markup: 'plain', source: { kind: 'localized', key: 'foyer-title' } },
          overlays: [],
          cast: [],
          props: [],
          compose: null,
          placements: [],
          exits: [],
          lifecycle: {
            canEnter: { kind: 'always' },
            canLeave: { kind: 'always' },
            hooks: [
              {
                hook: 'before-enter',
                effects: [
                  {
                    kind: 'set-variable',
                    variable: { kind: 'variable', id: 'visited' },
                    value: true,
                  },
                ],
              },
            ],
          },
        },
      ],
      interactables: [
        {
          id: 'key',
          extends: null,
          propertyAssignments: [],
          displayName: 'Key',
          presentation: { sprite: null, material: null },
          initialState: { location: { kind: 'nowhere' }, enabled: true, visible: true },
        },
      ],
      verbs: [
        {
          id: 'look',
          extends: null,
          propertyAssignments: [],
          arity: 0,
          operandRoles: [],
          quickAction: true,
          actionText: { markup: 'plain', source: { kind: 'inline', text: 'Look' } },
          availability: { kind: 'always' },
          defaultProgram: {
            instructions: [],
            completion: { kind: 'return' },
            outcome: 'unhandled',
          },
        },
      ],
      interactions: [
        {
          id: 'look-key',
          extends: null,
          propertyAssignments: [],
          rules: [
            {
              id: 'look-key-rule',
              verb: { kind: 'verb', id: 'look' },
              operands: [],
              context: { kind: 'any' },
              program: {
                instructions: [
                  {
                    id: 'notify-key',
                    kind: 'notify',
                    message: { markup: 'plain', source: { kind: 'inline', text: 'A key.' } },
                  },
                ],
                completion: { kind: 'return' },
                outcome: 'handled',
              },
            },
          ],
        },
      ],
      scenes: [
        {
          id: 'opening',
          extends: null,
          propertyAssignments: [],
          displayName: 'Opening',
          defaultLayout: null,
          defaultBackground: { asset: null, material: null, color: '#000000', fit: 'cover' },
          continuation: { kind: 'end' },
          program: {
            instructions: [{ id: 'wait-for-input', kind: 'wait-input', skippable: true }],
          },
        },
      ],
      dialogues: [
        {
          id: 'intro',
          extends: null,
          propertyAssignments: [],
          displayName: 'Intro',
          defaultSpeaker: { kind: 'character', id: 'hero' },
          settings: { showDisabledChoices: true, logMode: 'everything' },
          completion: { kind: 'end' },
          program: {
            entryBlockId: 'start',
            blocks: [
              {
                id: 'start',
                kind: 'sequence',
                defaultSpeaker: null,
                segments: [
                  {
                    id: 'line-1',
                    kind: 'line',
                    speaker: null,
                    text: { markup: 'active-text', source: { kind: 'inline', text: 'Hello' } },
                    effects: [],
                    showOnce: false,
                    logged: true,
                    autosaveSafePoint: true,
                  },
                ],
              },
            ],
            edges: [],
          },
        },
      ],
      maps: [
        {
          id: 'house-map',
          extends: null,
          propertyAssignments: [],
          presentation: { title: null, background: null, layout: null, initialMode: 'full-map' },
          locations: [
            {
              id: 'foyer-location',
              room: { kind: 'room', id: 'foyer' },
              position: { x: 0, y: 0 },
              shape: { kind: 'point' },
              label: null,
            },
          ],
          connections: [],
        },
      ],
    },
  };
}

describe('CompiledProject Wire V2', () => {
  it('round-trips a representative wire document for every runtime-content family', () => {
    const parsed = parseCompiledProjectWireV2(representativeWireFixture());
    const serialized = serializeCompiledProjectWireV2(parsed);

    expect(parseCompiledProjectWireV2(JSON.parse(serialized))).toEqual(parsed);
    expect(parsed.definitions).toMatchObject({
      characters: [{ id: 'hero' }],
      rooms: [{ id: 'foyer' }],
      interactables: [{ id: 'key' }],
      verbs: [{ id: 'look' }],
      interactions: [{ id: 'look-key' }],
      scenes: [{ id: 'opening' }],
      dialogues: [{ id: 'intro' }],
      maps: [{ id: 'house-map' }],
    });
  });

  it('rejects editor-only fields, legacy names, comments, and unknown nested fields', () => {
    const fixture = representativeWireFixture();
    expect(compiledProjectWireV2Schema.safeParse({ ...fixture, editor: {} }).success).toBe(false);
    expect(
      compiledProjectWireV2Schema.safeParse({
        ...fixture,
        categories: [],
        tags: [],
        objects: [],
        actions: [],
      }).success,
    ).toBe(false);

    const commentFixture = {
      ...representativeWireFixture(),
      definitions: {
        ...representativeWireFixture().definitions,
        scenes: [
          {
            ...representativeWireFixture().definitions.scenes[0]!,
            program: {
              instructions: [{ id: 'comment', kind: 'comment', text: 'Not runtime content.' }],
            },
          },
        ],
      },
    };
    expect(compiledProjectWireV2Schema.safeParse(commentFixture).success).toBe(false);

    const nestedUnknownFixture = {
      ...representativeWireFixture(),
      definitions: {
        ...representativeWireFixture().definitions,
        rooms: [
          {
            ...representativeWireFixture().definitions.rooms[0]!,
            background: {
              ...representativeWireFixture().definitions.rooms[0]!.background,
              editorPreviewColor: '#fff',
            },
          },
        ],
      },
    };
    expect(compiledProjectWireV2Schema.safeParse(nestedUnknownFixture).success).toBe(false);

    const duplicateIdFixture = {
      ...fixture,
      variables: [...fixture.variables, { ...fixture.variables[0]! }],
    };
    expect(compiledProjectWireV2Schema.safeParse(duplicateIdFixture).success).toBe(false);

    expect(
      compiledDiagnosticSchema.safeParse({
        code: 'wire.unknown-field',
        severity: 'error',
        sourcePath: '/rooms/foyer',
        jsonPointer: '/definitions/rooms/0',
        message: 'Unknown field.',
        sortKey: {
          code: 'wire.unknown-field',
          sourcePath: '/rooms/foyer',
          jsonPointer: '/definitions/rooms/0',
        },
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('rejects the provisional V1 display shape and version', () => {
    const fixture = representativeWireFixture();
    const provisional = {
      ...fixture,
      schemaVersion: 1,
      settings: {
        ...fixture.settings,
        display: {
          aspectRatio: { width: 16, height: 9 },
          orientation: 'landscape',
          barColor: '#000000',
        },
      },
    };

    expect(compiledProjectWireV2Schema.safeParse(provisional).success).toBe(false);
  });

  it('requires wire durations to use whole milliseconds', () => {
    const fixture = representativeWireFixture();
    const fractionalDurationFixture = {
      ...fixture,
      definitions: {
        ...fixture.definitions,
        scenes: [
          {
            ...fixture.definitions.scenes[0]!,
            program: {
              instructions: [
                {
                  id: 'fractional-wait',
                  kind: 'wait-duration',
                  durationMs: 0.5,
                  skippable: true,
                },
              ],
            },
          },
        ],
      },
    };

    expect(compiledProjectWireV2Schema.safeParse(fractionalDurationFixture).success).toBe(false);
  });

  it('rejects reference dimensions above the runtime display limit', () => {
    const fixture = representativeWireFixture();
    fixture.settings.display.referenceResolution.width = 10_001;

    expect(compiledProjectWireV2Schema.safeParse(fixture).success).toBe(false);
  });

  it('canonicalizes object keys without changing compiler-owned array order', () => {
    const fixture = parseCompiledProjectWireV2(representativeWireFixture());
    fixture.definitions.scenes.push({
      id: 'after-opening',
      extends: null,
      propertyAssignments: [],
      displayName: 'After opening',
      defaultLayout: null,
      defaultBackground: { asset: null, material: null, color: null, fit: 'cover' },
      continuation: { kind: 'end' },
      program: { instructions: [{ id: 'pause', kind: 'wait-input', skippable: false }] },
    });

    const serialized = serializeCompiledProjectWireV2(fixture);
    const decoded = parseCompiledProjectWireV2(JSON.parse(serialized));
    expect(decoded.definitions.scenes.map((scene) => scene.id)).toEqual([
      'opening',
      'after-opening',
    ]);
    expect(serialized.indexOf('\"definitions\"')).toBeLessThan(
      serialized.indexOf('\"entrypoint\"'),
    );

    const reorderedRoot = Object.fromEntries(Object.entries(fixture).reverse());
    expect(serializeCompiledProjectWireV2(reorderedRoot)).toBe(serialized);
  });
});
