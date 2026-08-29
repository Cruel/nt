import { describe, expect, it } from 'vite-plus/test';
import {
  compiledDiagnosticSchema,
  compiledProjectWireSchema,
  parseCompiledProjectWire,
  serializeCompiledProjectWire,
} from '../../shared/project-schema/compiled-project';

function representativeWireFixture() {
  return {
    schema: 'noveltea.compiled.project',
    schemaVersion: 1,
    saveContract: 'sc1:0123456789abcdef0123456789abcdef',
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
      audio: {
        purposes: {
          music: { volume: 1, muted: false },
          ambience: { volume: 1, muted: false },
          voice: { volume: 1, muted: false },
          'sound-effect': { volume: 1, muted: false },
          'ui-sound': { volume: 1, muted: false },
        },
        voiceDucking: { enabled: false, musicGain: 0.5, ambienceGain: 0.5 },
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
    bootstrapModule: { kind: 'script', id: 'bootstrap' },
    entrypoint: { kind: 'room', room: { kind: 'room', id: 'foyer' } },
    properties: [
      {
        id: 'mood',
        label: 'Mood',
        description: 'The current mood.',
        type: 'enum',
        nullable: false,
        enumValues: ['calm', 'tense'],
        owner: { kind: 'room', room: { kind: 'room', id: 'foyer' } },
        scope: 'identity',
      },
      {
        id: 'visited',
        label: 'Visited',
        description: '',
        type: 'boolean',
        nullable: false,
        defaultValue: false,
        enumValues: [],
        scope: 'global',
      },
    ],
    traits: [],
    archetypes: [],
    inventories: [{ id: 'player', label: 'Player Inventory' }],
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
          sampling: 'linear',
          width: 1920,
          height: 1080,
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
      materialInterfaces: [],
      scripts: [{ id: 'bootstrap', source: { kind: 'inline-lua', source: 'return {}' } }],
    },
    definitions: {
      characters: [
        {
          id: 'hero',
          traits: [],
          propertyAssignments: [],
          properties: [],
          displayName: 'Hero',
          dialogue: { name: 'Hero', nameColor: null, textColor: null, styleClass: '' },
          defaults: {
            profileId: 'stage',
            expressionId: 'neutral',
            appearanceId: null,
          },
          profiles: [
            {
              id: 'stage',
              layers: [{ id: 'body', role: 'body' }],
              defaultPoseId: 'default',
              animationClips: [],
              automaticAnimations: { blink: null, speaking: null },
              poses: [
                {
                  id: 'default',
                  layers: [
                    {
                      layerId: 'body',
                      sprite: null,
                      material: null,
                      offset: { x: 0, y: 0 },
                      scale: 1,
                      anchor: { x: 0.5, y: 1 },
                      visible: true,
                    },
                  ],
                },
              ],
            },
          ],
          expressions: [{ id: 'neutral', profiles: [] }],
          appearances: [],
          gestures: [],
          inventories: [{ id: 'pockets', label: 'Pockets' }],
          initialWorldState: {
            location: { kind: 'room', room: { kind: 'room', id: 'foyer' } },
            enabled: true,
            visible: true,
          },
        },
      ],
      rooms: [
        {
          id: 'foyer',
          traits: [],
          propertyAssignments: [{ propertyId: 'mood', value: 'calm' }],
          properties: [],
          displayName: 'Foyer',
          background: {
            asset: { kind: 'asset', id: 'foyer-image' },
            material: null,
            fit: 'cover',
            color: null,
          },
          description: { markup: 'plain', source: { kind: 'localized', key: 'foyer-title' } },
          presentationSpace: {
            size: { width: 1920, height: 1080 },
            bounds: null,
            edgePolicy: 'contain',
            defaultView: { center: { x: 960, y: 540 }, zoom: 1, rotationDegrees: 0 },
            views: [],
          },
          anchors: [],
          overlays: [],
          cast: [],
          interactables: [],
          props: [],
          scriptHooks: [],
          placements: [],
          exits: [],
          features: [],
          hotspots: [],
          lifecycle: {
            canEnter: { kind: 'always' },
            canLeave: { kind: 'always' },
          },
        },
      ],
      interactables: [
        {
          id: 'key',
          traits: [],
          propertyAssignments: [],
          displayName: 'Key',
          properties: [],
          features: [],
          inventories: [{ id: 'compartment', label: 'Compartment' }],
          presentation: {
            sprite: null,
            material: null,
            hotspots: {
              kind: 'custom',
              hotspots: [],
            },
          },
        },
      ],
      verbs: [
        {
          id: 'look',
          slots: [],
          bindingOrder: [],
          offers: [],
          actionText: { markup: 'plain', source: { kind: 'inline', text: 'Look' } },
          completedCommandText: { markup: 'plain', source: { kind: 'inline', text: 'Look' } },
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
          rules: [
            {
              id: 'look-key-rule',
              verb: { kind: 'verb', id: 'look' },
              slots: [],
              offer: null,
              guard: { kind: 'always' },
              priority: 0,
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
          displayName: 'Opening',
          stage: {
            kind: 'blank',
            background: { asset: null, material: null, color: '#000000', fit: 'cover' },
            layout: null,
          },
          inputs: [],
          outcomes: [],
          terminal: { kind: 'complete-game' },
          program: {
            events: [
              {
                id: 'wait-for-input',
                timeline: { trackId: 'main', startMs: 0, durationMs: 0 },
                completionDependencies: [],
                instruction: { id: 'wait-for-input', kind: 'wait-input', skippable: true },
              },
            ],
          },
        },
      ],
      dialogues: [
        {
          id: 'intro',
          displayName: 'Intro',
          defaultSpeaker: { kind: 'character', id: 'hero' },
          stageSlots: [],
          mediaSlots: [],
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
                    cues: [],
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
          presentation: { title: null, background: null, layout: null, initialMode: 'full-map' },
          locations: [
            {
              id: 'foyer-location',
              room: { kind: 'room', id: 'foyer' },
              regions: [
                {
                  points: [
                    { x: 0.1, y: 0.1 },
                    { x: 0.2, y: 0.1 },
                    { x: 0.2, y: 0.2 },
                  ],
                },
              ],
              label: null,
              icon: null,
              style: null,
              labelAnchor: null,
              connectionAnchor: null,
              visibility: { kind: 'always' },
              pickOrder: 0,
              logicalOrder: 0,
            },
          ],
          connections: [],
        },
      ],
    },
    interactableInstances: [
      {
        id: 'key',
        definition: { kind: 'interactable-definition', id: 'key' },
        location: {
          kind: 'inventory',
          inventory: { owner: { kind: 'project' }, inventoryId: 'player' },
        },
        enabled: true,
        visible: true,
        traitAdds: [],
        traitRemoves: [],
        propertyOverrides: [],
        localProperties: [],
      },
    ],
  };
}

describe('compiled project wire', () => {
  it('round-trips a representative wire document for every runtime-content family', () => {
    const parsed = parseCompiledProjectWire(representativeWireFixture());
    const serialized = serializeCompiledProjectWire(parsed);

    expect(parseCompiledProjectWire(JSON.parse(serialized))).toEqual(parsed);
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
    expect(compiledProjectWireSchema.safeParse({ ...fixture, editor: {} }).success).toBe(false);
    expect(
      compiledProjectWireSchema.safeParse({
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
    expect(compiledProjectWireSchema.safeParse(commentFixture).success).toBe(false);

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
    expect(compiledProjectWireSchema.safeParse(nestedUnknownFixture).success).toBe(false);

    const duplicateIdFixture = {
      ...fixture,
      properties: [...fixture.properties, { ...fixture.properties[0]! }],
    };
    expect(compiledProjectWireSchema.safeParse(duplicateIdFixture).success).toBe(false);

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

  it('rejects Property and Trait state on immutable program definitions', () => {
    const fixture = representativeWireFixture();
    const sceneWithState = {
      ...fixture,
      definitions: {
        ...fixture.definitions,
        scenes: [{ ...fixture.definitions.scenes[0]!, traits: [], propertyAssignments: [] }],
      },
    };
    expect(compiledProjectWireSchema.safeParse(sceneWithState).success).toBe(false);

    const propertyWithProgramOwner = {
      ...fixture,
      properties: [{ ...fixture.properties[0]!, ownerKinds: ['scene'] }],
    };
    expect(compiledProjectWireSchema.safeParse(propertyWithProgramOwner).success).toBe(false);
  });

  it('rejects the retired display shape within Compiled Project Format V1', () => {
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

    expect(compiledProjectWireSchema.safeParse(provisional).success).toBe(false);
  });

  it('requires sampling on images and forbids it on non-image resources', () => {
    const fixture = representativeWireFixture();
    const image = fixture.resources.assets[0]!;

    const missingImageSampling = {
      ...fixture,
      resources: {
        ...fixture.resources,
        assets: [{ id: image.id, kind: image.kind, path: image.path, aliases: image.aliases }],
      },
    };
    expect(compiledProjectWireSchema.safeParse(missingImageSampling).success).toBe(false);

    const nonImageSampling = {
      ...fixture,
      resources: {
        ...fixture.resources,
        assets: [
          ...fixture.resources.assets,
          {
            id: 'voice',
            kind: 'audio',
            path: 'audio/voice.ogg',
            aliases: [],
            sampling: 'nearest',
          },
        ],
      },
    };
    expect(compiledProjectWireSchema.safeParse(nonImageSampling).success).toBe(false);
  });

  it('accepts explicit linear and nearest image sampling', () => {
    const fixture = representativeWireFixture();
    const image = fixture.resources.assets[0]!;
    fixture.resources.assets.push({ ...image, id: 'pixel-image', sampling: 'nearest' });

    const parsed = parseCompiledProjectWire(fixture);
    expect(parsed.resources.assets).toEqual([
      expect.objectContaining({ id: 'foyer-image', kind: 'image', sampling: 'linear' }),
      expect.objectContaining({ id: 'pixel-image', kind: 'image', sampling: 'nearest' }),
    ]);
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

    expect(compiledProjectWireSchema.safeParse(fractionalDurationFixture).success).toBe(false);
  });

  it('rejects reference dimensions above the runtime display limit', () => {
    const fixture = representativeWireFixture();
    fixture.settings.display.referenceResolution.width = 10_001;

    expect(compiledProjectWireSchema.safeParse(fixture).success).toBe(false);
  });

  it('canonicalizes object keys without changing compiler-owned array order', () => {
    const fixture = parseCompiledProjectWire(representativeWireFixture());
    fixture.definitions.scenes.push({
      id: 'after-opening',
      displayName: 'After opening',
      stage: {
        kind: 'blank',
        background: { asset: null, material: null, color: null, fit: 'cover' },
        layout: null,
      },
      inputs: [],
      outcomes: [],
      terminal: { kind: 'complete-game' },
      program: {
        events: [
          {
            id: 'pause',
            timeline: { trackId: 'main', startMs: 0, durationMs: 0 },
            completionDependencies: [],
            instruction: { id: 'pause', kind: 'wait-input', skippable: false },
          },
        ],
      },
    });

    const serialized = serializeCompiledProjectWire(fixture);
    const decoded = parseCompiledProjectWire(JSON.parse(serialized));
    expect(decoded.definitions.scenes.map((scene) => scene.id)).toEqual([
      'opening',
      'after-opening',
    ]);
    expect(serialized.indexOf('"definitions"')).toBeLessThan(serialized.indexOf('"entrypoint"'));

    const reorderedRoot = Object.fromEntries(Object.entries(fixture).reverse());
    expect(serializeCompiledProjectWire(reorderedRoot)).toBe(serialized);
  });
});
