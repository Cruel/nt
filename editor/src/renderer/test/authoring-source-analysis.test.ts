import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import {
  analyzeAuthoringSourceContent,
  analyzeAuthoringSources,
  bindAuthoringSourceOwner,
  collectAuthoringLuaSources,
  collectAuthoringSourceRequirements,
  lexLuaStringLiterals,
} from '../../shared/authoring-source-analysis';
import {
  buildAuthoringDependencyGraph,
  buildAuthoringDependencyGraphContributionSet,
  enumerateAuthoringDependencyContributionKeys,
  projectAuthoringLiteralEvidence,
  reprojectAuthoringDependencyContributionFromCachedSources,
  serializeAuthoringDependencyDerivationDependency,
} from '../../shared/authoring-dependency-graph';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  LUA_REFERENCE_ANALYSIS_LIMITS,
  type LuaSourceSnapshot,
} from '../../shared/project-schema/authoring-lua-analysis';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultSceneData, defaultSceneStep } from '../../shared/project-schema/authoring-scenes';
import {
  defaultDialogueData,
  defaultDialogueSegment,
} from '../../shared/project-schema/authoring-dialogues';
import { defaultVerbData } from '../../shared/project-schema/authoring-verbs';
import { defaultInteractionData } from '../../shared/project-schema/authoring-interactions';
import { defaultMapData } from '../../shared/project-schema/authoring-maps';
import { defaultTestData } from '../../shared/project-schema/authoring-tests';
import { defaultShaderData } from '../../shared/project-schema/authoring-shaders';
import { compileAuthoringProject } from '../../shared/authoring-compiler';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { sha256HexBytes, sha256HexUtf8 } from '../../shared/web-crypto';
import type { AuthoringSourceReferenceRecognizer } from '../../shared/authoring-source-references';

const hash = (digit: string) => `sha256:${digit.repeat(64)}` as const;

describe('authoring Lua lexer', () => {
  it('computes browser-safe SHA-256 fingerprints over exact UTF-8 bytes', async () => {
    expect(await sha256HexUtf8('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256HexUtf8('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes block boundaries and large binary inputs without input-sized padding', async () => {
    for (const size of [55, 56, 63, 64, 65, 1024 * 1024 + 17]) {
      const bytes = new Uint8Array(size);
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = index & 0xff;
      expect(await sha256HexBytes(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('decodes Lua 5.5 quoted and long-bracket strings while skipping comments', () => {
    const result = lexLuaStringLiterals(String.raw`
      -- 'ignored'
      local a = 'room\nmain'
      local b = "asset\x2dmain"
      local c = [=[
layout-main]=]
    `);
    expect(result.complete).toBe(true);
    expect(result.literals.map((literal) => literal.decodedValue)).toEqual([
      'room\nmain',
      'asset-main',
      'layout-main',
    ]);
  });

  it('retains useful literals from malformed source and marks it incomplete', () => {
    const result = lexLuaStringLiterals(`local good = 'room-main'\nlocal bad = "unterminated`);
    expect(result.complete).toBe(false);
    expect(result.literals[0]?.decodedValue).toBe('room-main');
  });

  it('decodes Lua escape forms and diagnoses malformed lexical constructs', async () => {
    const decoded = lexLuaStringLiterals(
      String.raw`local value = "a\z` + '   \n\t' + String.raw`b\u{1f642}\255\x21"`,
    );
    expect(decoded.complete).toBe(true);
    expect(decoded.literals[0]?.decodedValue).toBe('ab🙂ÿ!');
    const escapedNewline = lexLuaStringLiterals('local value = "a\\\r\nb"');
    expect(escapedNewline.complete).toBe(true);
    expect(escapedNewline.literals[0]?.decodedValue).toBe('a\nb');
    const malformed = await analyzeAuthoringSourceContent({
      sourceUrl: 'authoring:inline-lua',
      kind: 'lua',
      text: String.raw`local value = "bad\q"`,
    });
    expect(malformed.complete).toBe(false);
    expect(
      malformed.diagnostics.some(
        (diagnostic) => diagnostic.code === 'authoring.lua.lexical_incomplete',
      ),
    ).toBe(true);
    const surrogate = await analyzeAuthoringSourceContent({
      sourceUrl: 'authoring:inline-lua',
      kind: 'lua',
      text: String.raw`local value = "\u{d800}"`,
    });
    expect(surrogate.complete).toBe(false);
    expect(
      surrogate.diagnostics.some(
        (diagnostic) => diagnostic.code === 'authoring.lua.lexical_incomplete',
      ),
    ).toBe(true);
  });
});

describe('RML Lua extraction', () => {
  it('uses decoded event attributes and original raw script bytes', async () => {
    const artifact = await analyzeAuthoringSourceContent({
      sourceUrl: 'authoring:/layouts/hud/data/rml/sourceText',
      kind: 'rml',
      text: `<rml><body><button onclick="open(&quot;room-main&quot;)">Go</button><script>local x = '<tag>&quot;'</script></body></rml>`,
    });
    expect(artifact.complete).toBe(true);
    expect(artifact.regions.map((region) => region.sourceKind)).toEqual([
      'rml-event-attribute',
      'rml-inline-script',
    ]);
    expect(artifact.regions[0]?.decodedSource).toBe(`open("room-main")`);
    expect(artifact.regions[1]?.decodedSource).toBe(`local x = '<tag>&quot;'`);
    expect(artifact.literalOccurrences.map((literal) => literal.decodedValue)).toEqual([
      'room-main',
      '<tag>&quot;',
    ]);
  });

  it('reports event-attribute source evidence at physical file coordinates', async () => {
    const artifact = await analyzeAuthoringSourceContent({
      sourceUrl: 'project:/ui/layout.rml',
      kind: 'rml',
      text: `<rml>\n  <button onclick="open('room-main')">Go</button>\n</rml>`,
    });
    expect(artifact.literalOccurrences).toContainEqual(
      expect.objectContaining({
        sourceUrl: 'project:/ui/layout.rml',
        decodedValue: 'room-main',
        line: 2,
        column: 25,
      }),
    );
  });

  it('recognizes direct listener/load strings with parent provenance', async () => {
    const artifact = await analyzeAuthoringSourceContent({
      sourceUrl: 'authoring:/startupHook/source',
      kind: 'lua',
      text: `element:AddEventListener('click', "open('room-main')")\nload("return 'asset-main'")`,
    });
    expect(artifact.regions.some((region) => region.sourceKind === 'lua-listener-string')).toBe(
      true,
    );
    expect(artifact.regions.some((region) => region.sourceKind === 'lua-load-string')).toBe(true);
    expect(
      artifact.regions
        .filter((region) => region.parentRegionOrdinal !== undefined)
        .every((region) => region.parentRegionOrdinal === 0),
    ).toBe(true);
  });

  it('rejects non-direct listener/load expressions and bounds nested recognition depth', async () => {
    const artifact = await analyzeAuthoringSourceContent({
      sourceUrl: 'authoring:inline-lua',
      kind: 'lua',
      text: `
        AddEventListener('click', "ignored()")
        element:AddEventListener('click', prefix .. "ignored()")
        module.load("ignored()")
        load ("ignored()")
        load([[load("load('return 1')")]])
      `,
      limits: { maxSourceBytes: 1024, maxEmbeddedListenerDepth: 2 },
    });
    expect(
      artifact.regions.filter((region) => region.sourceKind === 'lua-listener-string'),
    ).toHaveLength(0);
    expect(
      artifact.regions.filter((region) => region.sourceKind === 'lua-load-string'),
    ).toHaveLength(2);
  });

  it('warns for malformed raw-text containers without suppressing prior regions', async () => {
    const artifact = await analyzeAuthoringSourceContent({
      sourceUrl: 'asset:rml',
      kind: 'rml',
      text: `<rml><button onclick="go('room-main')"/><script>local x = '<'`,
    });
    expect(artifact.complete).toBe(false);
    expect(
      artifact.literalOccurrences.some((literal) => literal.decodedValue === 'room-main'),
    ).toBe(true);
    expect(
      artifact.diagnostics.some((diagnostic) => diagnostic.code === 'authoring.lua.rml_raw_text'),
    ).toBe(true);
  });

  it('masks only real RML raw-text elements and ignores tag-like attribute/comment text', async () => {
    const artifact = await analyzeAuthoringSourceContent({
      sourceUrl: 'project:/ui/layout.rml',
      kind: 'rml',
      text: `<rml><!-- <script>ignored()</script> --><body data-note="&lt;script&gt;ignored()&lt;/script&gt;"><script>local value = 'room-main'</script></body></rml>`,
    });
    expect(artifact.complete).toBe(true);
    expect(
      artifact.regions.filter((region) => region.sourceKind === 'rml-inline-script'),
    ).toHaveLength(1);
    expect(artifact.literalOccurrences.map((literal) => literal.decodedValue)).toEqual([
      'room-main',
    ]);
  });

  it('preserves raw script bytes across XML-looking text, CDATA text, styles, and adjacent scripts', async () => {
    const first = `local a = '<node>&value'\nlocal b = '<![CDATA['\n-- <fake-tag>`;
    const second = `local c = 'second'`;
    const artifact = await analyzeAuthoringSourceContent({
      sourceUrl: 'project:/ui/raw.rml',
      kind: 'rml',
      text: `<rml><body><script>${first}</script><style>.x::before { content: "<tag>&"; }</style><script>${second}</script></body></rml>`,
    });
    expect(artifact.complete).toBe(true);
    expect(
      artifact.regions
        .filter((region) => region.sourceKind === 'rml-inline-script')
        .map((region) => region.decodedSource),
    ).toEqual([first, second]);
    expect(artifact.literalOccurrences.map((literal) => literal.decodedValue)).toEqual([
      '<node>&value',
      '<![CDATA[',
      'second',
    ]);
  });

  it('treats an empty src attribute as external rather than inline script content', async () => {
    const artifact = await analyzeAuthoringSourceContent({
      sourceUrl: 'project:/ui/external.rml',
      kind: 'rml',
      text: `<rml><body><script src="">local value = 'must-not-index'</script></body></rml>`,
    });
    expect(artifact.complete).toBe(true);
    expect(artifact.regions).toEqual([]);
    expect(artifact.literalOccurrences).toEqual([]);
  });
});

describe('typed source registry and graph evidence', () => {
  function fixture() {
    const project = createAuthoringProject();
    project.startupHook = { source: `local target = 'shared'` };
    project.rooms.shared = {
      id: 'shared',
      label: 'Shared room',
      data: {
        kind: 'room',
        description: { source: { kind: 'lua-expression', source: `'asset-main'` } },
      },
      properties: {},
      traits: [],
    } as never;
    project.assets.shared = {
      id: 'shared',
      label: 'Shared asset',
      data: { kind: 'image', path: 'shared.png' },
      properties: {},
      traits: [],
    } as never;
    project.assets['script-file'] = {
      id: 'script-file',
      label: 'Script',
      data: { kind: 'script', path: 'scripts/main.lua', extension: '.lua', contentHash: hash('1') },
      properties: {},
      traits: [],
    } as never;
    project.scripts.main = {
      id: 'main',
      label: 'Main',
      data: {
        kind: 'script-module',
        source: { kind: 'asset', asset: { $ref: { collection: 'assets', id: 'script-file' } } },
      },
      properties: {},
      traits: [],
    } as never;
    return project;
  }

  it('enumerates exact owners and excludes Shader source from Lua ownership', () => {
    const project = fixture();
    project.shaders.effect = {
      id: 'effect',
      label: 'Effect',
      data: { kind: 'shader', source: { sourceMode: 'inline', sourceText: `'shared'` } },
      properties: {},
      traits: [],
    } as never;
    const sources = collectAuthoringLuaSources(project);
    expect(sources.some((source) => source.contributionKey === 'record:shaders:effect')).toBe(
      false,
    );
    expect(sources.map((source) => source.contributionKey)).toContain(
      `project-field:${JSON.stringify('/startupHook')}`,
    );
    expect(collectAuthoringSourceRequirements(project)).toEqual(['script-file']);
  });

  it('discovers every registered shared execution surface without broad non-Lua owners', () => {
    const project = fixture();
    const room = defaultRoomData('Room');
    room.description.source = {
      kind: 'lua-expression',
      source: `room_text()`,
      additionalDependencies: { targets: [] },
    };
    room.compose = {
      script: { $ref: { collection: 'scripts', id: 'main' } },
      additionalDependencies: { targets: [] },
    };
    const scene = defaultSceneData('Scene');
    scene.steps = [defaultSceneStep('run-lua', 'scene-step')];
    const dialogue = defaultDialogueData('Dialogue');
    if (dialogue.blocks[0]?.type === 'sequence')
      dialogue.blocks[0].segments = [defaultDialogueSegment('run-lua', 'dialogue-segment')];
    const verb = defaultVerbData('Verb');
    verb.availability = {
      kind: 'lua-predicate',
      source: `verb_available()`,
      additionalDependencies: { targets: [] },
    };
    const interaction = defaultInteractionData();
    interaction.rules = [
      {
        id: 'rule',
        verb: { $ref: { collection: 'verbs', id: 'verb' } },
        operands: [],
        context: {
          kind: 'predicate',
          condition: {
            kind: 'lua-predicate',
            source: `interaction_allowed()`,
            additionalDependencies: { targets: [] },
          },
        },
        program: {
          instructions: [
            {
              id: 'effect',
              kind: 'apply-effect',
              effect: { kind: 'run-lua-effect', source: `interaction_effect()` },
            },
          ],
          completion: { kind: 'return' },
          outcome: 'handled',
        },
      },
    ];
    const test = defaultTestData('Test');
    test.initScript = `test_init()`;
    test.steps[0]!.checkScript = `test_check()`;
    const map = defaultMapData();
    map.presentation.title = {
      source: {
        kind: 'lua-expression',
        source: `map_title()`,
        additionalDependencies: { targets: [] },
      },
      markup: 'plain',
    };
    const surfaces = [
      ['rooms', 'room', room],
      ['scenes', 'scene', scene],
      ['dialogues', 'dialogue', dialogue],
      ['verbs', 'verb', verb],
      ['interactions', 'interaction', interaction],
      ['tests', 'test', test],
      ['maps', 'map', map],
    ] as const;
    for (const [collection, id, data] of surfaces)
      project[collection][id] = {
        id,
        label: id,
        data,
        properties: {},
        traits: [],
      } as never;
    const sources = collectAuthoringLuaSources(project);
    for (const [collection, id] of surfaces)
      expect(
        sources.some(
          (source) =>
            source.contributionKey === `record:${JSON.stringify(['record', collection, id])}`,
        ),
      ).toBe(true);
    expect(sources.some((source) => source.contributionKey.includes('assets'))).toBe(false);
    expect(sources.some((source) => source.contributionKey.includes('shaders'))).toBe(false);
    expect(
      sources.some(
        (source) =>
          source.contributionKey === `record:${JSON.stringify(['record', 'tests', 'test'])}` &&
          source.sourcePath.endsWith('/initScript'),
      ),
    ).toBe(true);
    expect(
      sources.some(
        (source) =>
          source.contributionKey === `record:${JSON.stringify(['record', 'rooms', 'room'])}` &&
          source.sourceAssetId === 'script-file',
      ),
    ).toBe(true);
    expect(new Set(sources.map((source) => source.executionSurface))).toEqual(
      new Set([
        'project-startup-hook',
        'script-record',
        'room-composition-script',
        'shared-lua-predicate',
        'shared-lua-expression',
        'shared-run-lua-effect',
        'scene-run-lua-step',
        'dialogue-run-lua-segment',
        'test-init-script',
        'test-check-script',
      ]),
    );
  });

  it('keeps content artifacts owner-neutral and cheaply rebinds provenance', async () => {
    const artifact = await analyzeAuthoringSourceContent({
      sourceUrl: 'project:/scripts/main.lua',
      kind: 'lua',
      text: `'shared'`,
      contentHash: hash('1'),
    });
    const project = fixture();
    const descriptor = collectAuthoringLuaSources(project).find(
      (source) =>
        source.contributionKey === `record:${JSON.stringify(['record', 'scripts', 'main'])}`,
    )!;
    const rebound = await bindAuthoringSourceOwner(descriptor, [artifact]);
    expect(artifact.literalOccurrences[0]).not.toHaveProperty('sourcePath');
    expect(rebound.literalOccurrences[0]?.sourcePath).toBe('/scripts/main/data/source/asset/$ref');
    project.scripts.renamed = {
      ...project.scripts.main,
      id: 'renamed',
    } as never;
    delete project.scripts.main;
    const renamedDescriptor = collectAuthoringLuaSources(project).find(
      (source) =>
        source.contributionKey === `record:${JSON.stringify(['record', 'scripts', 'renamed'])}`,
    )!;
    const renamed = await bindAuthoringSourceOwner(renamedDescriptor, [artifact]);
    expect(renamed.sourceContentFingerprints).toEqual(rebound.sourceContentFingerprints);
    expect(renamed.ownerProjectionFingerprint).not.toBe(rebound.ownerProjectionFingerprint);
    expect(renamed.literalOccurrences[0]?.sourcePath).toBe(
      '/scripts/renamed/data/source/asset/$ref',
    );
    const changedArtifact = await analyzeAuthoringSourceContent({
      sourceUrl: 'project:/scripts/main.lua',
      kind: 'lua',
      text: `'changed'`,
      contentHash: hash('2'),
    });
    expect(
      (await bindAuthoringSourceOwner(renamedDescriptor, [changedArtifact]))
        .ownerProjectionFingerprint,
    ).not.toBe(renamed.ownerProjectionFingerprint);
  });

  it('adds ambiguous lexical tooling evidence only in enabled mode', async () => {
    const project = fixture();
    const snapshot: LuaSourceSnapshot = {
      entriesByAssetId: new Map([
        [
          'script-file',
          {
            status: 'ready',
            assetId: 'script-file',
            projectRelativePath: 'scripts/main.lua',
            contentHash: hash('1'),
            text: `'shared'`,
            hadUtf8Bom: false,
          },
        ],
      ]),
    };
    const disabled = await buildAuthoringDependencyGraph(project, { mode: 'disabled' });
    const enabled = await buildAuthoringDependencyGraph(project, {
      mode: 'enabled',
      sources: snapshot,
    });
    expect(
      [...disabled.edgesById.values()].some((edge) => edge.role === 'lua-possible-reference'),
    ).toBe(false);
    const luaEdges = [...enabled.edgesById.values()].filter(
      (edge) => edge.role === 'lua-possible-reference',
    );
    expect(luaEdges.length).toBeGreaterThanOrEqual(4);
    expect(
      luaEdges.every((edge) => edge.facets.length === 1 && edge.facets[0] === 'validation'),
    ).toBe(true);
    expect(
      luaEdges.some(
        (edge) =>
          edge.evidence?.[0]?.kind === 'lua-occurrence' &&
          edge.evidence[0].occurrence.candidateTargets.length === 2,
      ),
    ).toBe(true);
  });

  it('allows a future recognizer to promote one occurrence without changing graph algorithms', async () => {
    const project = fixture();
    project.startupHook = { source: `local target = 'shared'` };
    const sources: LuaSourceSnapshot = {
      entriesByAssetId: new Map([
        [
          'script-file',
          {
            status: 'ready',
            assetId: 'script-file',
            projectRelativePath: 'scripts/main.lua',
            contentHash: hash('1'),
            text: `local unrelated = 'shared'`,
            hadUtf8Bom: false,
          },
        ],
      ]),
    };
    const recognizer: AuthoringSourceReferenceRecognizer = {
      id: 'test.future-reference',
      recognize: ({ occurrence }) =>
        occurrence.decodedValue === 'shared' && occurrence.sourceUrl === 'authoring:inline-lua'
          ? {
              classification: 'exact-rewriteable',
              target: { kind: 'record', collection: 'rooms', id: 'shared' },
              rewriteRange: {
                startUtf16: occurrence.regionStartUtf16 + 1,
                endUtf16: occurrence.regionEndUtf16 - 1,
                expectedText: 'shared',
              },
            }
          : null,
    };
    const lexical = await buildAuthoringDependencyGraph(project, { mode: 'enabled', sources });
    const recognized = await buildAuthoringDependencyGraph(project, { mode: 'enabled', sources }, [
      recognizer,
    ]);
    expect(
      [...lexical.edgesById.values()].some(
        (edge) =>
          edge.target.kind === 'record' &&
          edge.target.collection === 'rooms' &&
          edge.target.id === 'shared' &&
          edge.role === 'lua-possible-reference',
      ),
    ).toBe(true);
    expect(
      [...recognized.edgesById.values()].some(
        (edge) =>
          edge.target.kind === 'record' &&
          edge.target.collection === 'rooms' &&
          edge.target.id === 'shared' &&
          edge.role === 'lua-recognized-reference' &&
          edge.evidence?.some(
            (evidence) =>
              evidence.kind === 'lua-occurrence' &&
              evidence.classification === 'exact-rewriteable' &&
              evidence.recognizedBy === 'test.future-reference',
          ),
      ),
    ).toBe(true);
  });

  it('keeps lexical Lua candidates validation-only across source kinds', async () => {
    const project = fixture();
    const layout = defaultLayoutData('HUD');
    layout.rml.sourceText = `<rml><body><button onclick="open('shared')"/></body></rml>`;
    layout.lua.sourceText = `local target = 'shared'`;
    layout.script.enabled = false;
    project.layouts.hud = {
      id: 'hud',
      label: 'HUD',
      data: layout,
      properties: {},
      traits: [],
    } as never;
    const graph = await buildAuthoringDependencyGraph(project, {
      mode: 'enabled',
      sources: {
        entriesByAssetId: new Map([
          [
            'script-file',
            {
              status: 'ready',
              assetId: 'script-file',
              projectRelativePath: 'scripts/main.lua',
              contentHash: hash('1'),
              text: `'shared'`,
              hadUtf8Bom: false,
            },
          ],
        ]),
      },
    });
    const layoutEdges = [...graph.edgesById.values()].filter(
      (edge) =>
        edge.role === 'lua-possible-reference' &&
        edge.source.kind === 'record' &&
        edge.source.collection === 'layouts' &&
        edge.source.id === 'hud',
    );
    for (const edge of layoutEdges) {
      expect(edge.facets.includes('validation')).toBe(true);
      expect(edge.facets.includes('reference-integrity')).toBe(false);
      expect(edge.facets.includes('tooling-reference')).toBe(false);
    }
  });

  it('retains unrelated owner evidence when another source is malformed', async () => {
    const project = fixture();
    const layout = defaultLayoutData('HUD');
    layout.rml.sourceText = `<rml><body><button onclick="open('shared')"/><script>local broken = "unterminated</script></body></rml>`;
    layout.lua.sourceText = `local target = 'shared'`;
    project.layouts.hud = {
      id: 'hud',
      label: 'HUD',
      data: layout,
      properties: {},
      traits: [],
    } as never;
    const snapshot: LuaSourceSnapshot = {
      entriesByAssetId: new Map([
        [
          'script-file',
          {
            status: 'ready',
            assetId: 'script-file',
            projectRelativePath: 'scripts/main.lua',
            contentHash: hash('1'),
            text: `'shared'`,
            hadUtf8Bom: false,
          },
        ],
      ]),
    };
    const graph = await buildAuthoringDependencyGraph(project, {
      mode: 'enabled',
      sources: snapshot,
    });
    expect(
      [...graph.edgesById.values()].some(
        (edge) =>
          edge.role === 'lua-possible-reference' &&
          edge.source.kind === 'record' &&
          edge.source.collection === 'layouts' &&
          edge.source.id === 'hud' &&
          edge.sourcePath.endsWith('/lua/sourceText'),
      ),
    ).toBe(true);
    expect(
      graph.diagnostics.some(
        (diagnostic) => diagnostic.code === 'authoring.lua.lexical_incomplete',
      ),
    ).toBe(true);
  });

  it('excludes Room placement and exit IDs from generic lexical projection', async () => {
    const project = createAuthoringProject();
    const target = defaultRoomData('Target');
    project.rooms.target = {
      id: 'target',
      label: 'Target',
      data: target,
      properties: {},
      traits: [],
    } as never;
    const room = defaultRoomData('Room');
    room.placements = [
      {
        id: 'nested-placement',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        presentation: { label: null, layout: null },
      },
    ];
    room.exits = [
      {
        id: 'nested-exit',
        label: 'Exit',
        direction: 'east',
        target: { $ref: { collection: 'rooms', id: 'target' } },
        condition: { kind: 'always' },
      },
    ];
    project.rooms.room = {
      id: 'room',
      label: 'Room',
      data: room,
      properties: {},
      traits: [],
    } as never;
    project.scripts.main = {
      id: 'main',
      label: 'Main',
      data: {
        kind: 'script-module',
        source: {
          kind: 'inline-lua',
          source: `'nested-placement' 'nested-exit'`,
        },
      },
      properties: {},
      traits: [],
    } as never;
    const graph = await buildAuthoringDependencyGraph(project, {
      mode: 'enabled',
      sources: { entriesByAssetId: new Map() },
    });
    expect(
      [...graph.edgesById.values()].some((edge) => edge.role === 'lua-possible-reference'),
    ).toBe(false);
  });

  it('uses deterministic contribution keys and graph ordering', async () => {
    const project = fixture();
    const keys = enumerateAuthoringDependencyContributionKeys(project);
    expect(keys).toEqual([...keys].sort());
    const left = await buildAuthoringDependencyGraph(project, { mode: 'disabled' });
    const right = await buildAuthoringDependencyGraph(structuredClone(project), {
      mode: 'disabled',
    });
    expect([...left.edgesById.keys()]).toEqual([...right.edgesById.keys()]);
  });

  it('resolves declared external scripts and a cycle-safe transitive template closure', async () => {
    const project = fixture();
    const asset = (
      id: string,
      kind: 'script' | 'text',
      sourcePath: string,
      contentHash: string,
    ) => {
      project.assets[id] = {
        id,
        label: id,
        data: {
          kind,
          source: { type: 'project-file', path: sourcePath },
          aliases: [],
          extension: sourcePath.slice(sourcePath.lastIndexOf('.')),
          contentHash,
          imageMetadata: null,
        },
        properties: {},
        traits: [],
      } as never;
    };
    asset('hud-script', 'script', 'ui/scripts/hud.lua', hash('2'));
    asset('base-template', 'text', 'ui/templates/base.rml', hash('3'));
    asset('nested-template', 'text', 'ui/templates/nested.rml', hash('4'));
    const layout = defaultLayoutData('HUD', 'document');
    layout.rml.sourceText = `<rml><head><script src="ui/scripts/hud.lua"/><link type="text/template" href="ui/templates/base.rml"/></head><body template="base"/></rml>`;
    layout.dependencies.scripts = [{ $ref: { collection: 'assets', id: 'hud-script' } }];
    layout.dependencies.templates = [
      { $ref: { collection: 'assets', id: 'base-template' } },
      { $ref: { collection: 'assets', id: 'nested-template' } },
    ];
    project.layouts.hud = {
      id: 'hud',
      label: 'HUD',
      data: layout,
      properties: {},
      traits: [],
    } as never;
    const snapshot: LuaSourceSnapshot = {
      entriesByAssetId: new Map([
        [
          'script-file',
          {
            status: 'ready',
            assetId: 'script-file',
            projectRelativePath: 'scripts/main.lua',
            contentHash: hash('1'),
            text: `'shared'`,
            hadUtf8Bom: false,
          },
        ],
        [
          'hud-script',
          {
            status: 'ready',
            assetId: 'hud-script',
            projectRelativePath: 'ui/scripts/hud.lua',
            contentHash: hash('2'),
            text: `local room = 'shared'`,
            hadUtf8Bom: false,
          },
        ],
        [
          'base-template',
          {
            status: 'ready',
            assetId: 'base-template',
            projectRelativePath: 'ui/templates/base.rml',
            contentHash: hash('3'),
            text: `<template name="base"><link type="text/template" href="nested.rml"/><button onclick="go('shared')"/></template>`,
            hadUtf8Bom: false,
          },
        ],
        [
          'nested-template',
          {
            status: 'ready',
            assetId: 'nested-template',
            projectRelativePath: 'ui/templates/nested.rml',
            contentHash: hash('4'),
            text: `<template name="nested"><link type="text/template" href="base.rml"/><script>local x = 'shared'</script></template>`,
            hadUtf8Bom: false,
          },
        ],
      ]),
    };
    const analyses = (await analyzeAuthoringSources(project, snapshot)).get(
      `record:${JSON.stringify(['record', 'layouts', 'hud'])}`,
    )!;
    expect(analyses.flatMap((item) => item.sourceAssetIds).sort()).toEqual([
      'base-template',
      'hud-script',
      'nested-template',
    ]);
    expect(
      analyses
        .flatMap((item) => item.literalOccurrences)
        .filter((item) => item.decodedValue === 'shared'),
    ).toHaveLength(3);
    expect(
      analyses
        .flatMap((item) => item.literalOccurrences)
        .flatMap((item) => (item.sourceAssetId ? [item.sourceAssetId] : []))
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(['base-template', 'hud-script', 'nested-template']);
    expect(analyses.flatMap((item) => item.diagnostics)).toEqual([]);
    const graph = await buildAuthoringDependencyGraph(project, {
      mode: 'enabled',
      sources: snapshot,
    });
    expect(
      [...graph.edgesById.values()].some(
        (edge) =>
          edge.role === 'lua-possible-reference' &&
          edge.evidence?.some(
            (evidence) =>
              evidence.kind === 'lua-occurrence' &&
              evidence.occurrence.sourceAssetId === 'hud-script',
          ),
      ),
    ).toBe(true);
  });

  it('diagnoses unsafe external URIs and bounded template traversal deterministically', async () => {
    const project = fixture();
    project.assets.panel = {
      id: 'panel',
      label: 'Panel',
      data: {
        kind: 'text',
        source: { type: 'project-file', path: 'panel.rml' },
        aliases: [],
        contentHash: hash('8'),
        imageMetadata: null,
      },
      properties: {},
      traits: [],
    } as never;
    const layout = defaultLayoutData('HUD');
    layout.rml.sourceText = `<rml><head><script src=""/><script src="../escape.lua"/><link type="text/template" href="panel.rml"/></head><body template="panel"/></rml>`;
    layout.dependencies.templates = [{ $ref: { collection: 'assets', id: 'panel' } }];
    project.layouts.hud = {
      id: 'hud',
      label: 'HUD',
      data: layout,
      properties: {},
      traits: [],
    } as never;
    const analyses = (
      await analyzeAuthoringSources(
        project,
        {
          entriesByAssetId: new Map([
            [
              'script-file',
              {
                status: 'ready',
                assetId: 'script-file',
                projectRelativePath: 'scripts/main.lua',
                contentHash: hash('1'),
                text: `'shared'`,
                hadUtf8Bom: false,
              },
            ],
            [
              'panel',
              {
                status: 'ready',
                assetId: 'panel',
                projectRelativePath: 'panel.rml',
                contentHash: hash('8'),
                text: `<template name="panel"><script>local x = 'shared'</script></template>`,
                hadUtf8Bom: false,
              },
            ],
          ]),
        },
        {
          ...LUA_REFERENCE_ANALYSIS_LIMITS,
          maxTemplatesPerLayout: 0,
        },
        new Set([`record:${JSON.stringify(['record', 'layouts', 'hud'])}`]),
      )
    ).get(`record:${JSON.stringify(['record', 'layouts', 'hud'])}`)!;
    const diagnosticCodes = analyses
      .flatMap((analysis) => analysis.diagnostics)
      .map((diagnostic) => diagnostic.code)
      .sort();
    expect(diagnosticCodes).toContain('authoring.lua.external_source_unresolved');
    expect(diagnosticCodes).toContain('authoring.lua.template_limit');
    expect(diagnosticCodes).toContain('authoring.lua.template_name_missing');
  });

  it('collapses repeated mentions into one edge with sorted occurrence evidence', async () => {
    const project = createAuthoringProject();
    project.rooms.shared = {
      id: 'shared',
      label: 'Shared',
      data: defaultRoomData('Shared'),
      properties: {},
      traits: [],
    } as never;
    project.scripts.main = {
      id: 'main',
      label: 'Main',
      data: {
        kind: 'script-module',
        source: { kind: 'inline-lua', source: `'shared' 'shared'` },
      },
      properties: {},
      traits: [],
    } as never;
    const graph = await buildAuthoringDependencyGraph(project, {
      mode: 'enabled',
      sources: { entriesByAssetId: new Map() },
    });
    const edges = [...graph.edgesById.values()].filter(
      (edge) =>
        edge.role === 'lua-possible-reference' &&
        edge.source.kind === 'record' &&
        edge.source.collection === 'scripts' &&
        edge.source.id === 'main' &&
        edge.target.kind === 'record' &&
        edge.target.collection === 'rooms' &&
        edge.target.id === 'shared',
    );
    expect(edges).toHaveLength(1);
    const occurrences = edges[0]!
      .evidence!.filter((evidence) => evidence.kind === 'lua-occurrence')
      .map((evidence) => evidence.occurrence.regionStartUtf16);
    expect(occurrences).toEqual([...occurrences].sort((left, right) => left - right));
    expect(occurrences).toHaveLength(2);
  });

  it('indexes only exact source, localization, and property derivation dependencies', async () => {
    const project = fixture();
    const addAsset = (
      id: string,
      path: string,
      kind: 'script' | 'text' | 'shader-source' = 'text',
    ) => {
      project.assets[id] = {
        id,
        label: id,
        data: {
          kind,
          source: { type: 'project-file', path },
          aliases: [],
          contentHash: hash(id.length.toString().at(-1) ?? '1'),
          imageMetadata: null,
        },
        properties: {},
        traits: [],
      } as never;
    };
    addAsset('script-file', 'scripts/main.lua', 'script');
    addAsset('layout-rml', 'ui/hud.rml');
    addAsset('layout-rcss', 'ui/hud.rcss');
    addAsset('layout-lua', 'ui/hud.lua', 'script');
    addAsset('external-script', 'ui/external.lua', 'script');
    addAsset('template-file', 'ui/panel.rml');
    addAsset('unused-script', 'ui/unused.lua', 'script');
    addAsset('unused-template', 'ui/unused.rml');
    addAsset('shader-file', 'shaders/effect.sc', 'shader-source');

    const layout = defaultLayoutData('HUD');
    layout.rml = {
      sourceMode: 'asset',
      sourceText: 'inactive inline RML',
      sourceAsset: { $ref: { collection: 'assets', id: 'layout-rml' } },
    };
    layout.rcss = {
      sourceMode: 'asset',
      sourceText: 'inactive inline RCSS',
      sourceAsset: { $ref: { collection: 'assets', id: 'layout-rcss' } },
    };
    layout.lua = {
      sourceMode: 'asset',
      sourceText: 'inactive inline Lua',
      sourceAsset: { $ref: { collection: 'assets', id: 'layout-lua' } },
    };
    layout.dependencies.scripts = [
      { $ref: { collection: 'assets', id: 'external-script' } },
      { $ref: { collection: 'assets', id: 'unused-script' } },
    ];
    layout.dependencies.templates = [
      { $ref: { collection: 'assets', id: 'template-file' } },
      { $ref: { collection: 'assets', id: 'unused-template' } },
    ];
    layout.script.additionalDependencies = {
      targets: [
        {
          kind: 'property-value',
          owner: { kind: 'room', id: 'shared' },
          propertyId: 'mood',
        },
      ],
    };
    project.layouts.hud = {
      id: 'hud',
      label: 'HUD',
      data: layout,
      properties: {},
      traits: [],
    } as never;

    const room = defaultRoomData('Shared');
    room.description = {
      source: { kind: 'localized', key: 'greeting' },
      markup: 'plain',
    };
    project.rooms.shared = {
      id: 'shared',
      label: 'Shared',
      data: room,
      properties: { ordinary: 'value' },
      traits: [],
    } as never;
    project.localization.defaultLocale = 'en';
    project.localization.fallbackLocale = 'en';
    project.localization.catalogs.en = { greeting: 'Hello' };

    const shader = defaultShaderData('Effect');
    shader.stages[0] = {
      ...shader.stages[0]!,
      sourceMode: 'asset',
      sourceAsset: { $ref: { collection: 'assets', id: 'shader-file' } },
      sourceText: 'inactive shader source',
    };
    project.shaders.effect = {
      id: 'effect',
      label: 'Effect',
      data: shader,
      properties: {},
      traits: [],
    } as never;

    const ready = (assetId: string, projectRelativePath: string, text: string, digit: string) =>
      ({
        status: 'ready',
        assetId,
        projectRelativePath,
        contentHash: hash(digit),
        text,
        hadUtf8Bom: false,
      }) as const;
    const snapshot: LuaSourceSnapshot = {
      entriesByAssetId: new Map([
        ['script-file', ready('script-file', 'scripts/main.lua', `'shared'`, '1')],
        [
          'layout-rml',
          ready(
            'layout-rml',
            'ui/hud.rml',
            `<rml><head><script src="external.lua"/><link type="text/template" href="panel.rml"/></head><body template="panel"/></rml>`,
            '2',
          ),
        ],
        ['layout-lua', ready('layout-lua', 'ui/hud.lua', `'shared'`, '3')],
        ['external-script', ready('external-script', 'ui/external.lua', `'shared'`, '4')],
        [
          'template-file',
          ready(
            'template-file',
            'ui/panel.rml',
            `<template name="panel"><button onclick="open('shared')"/></template>`,
            '5',
          ),
        ],
        ['unused-script', ready('unused-script', 'ui/unused.lua', `'unused'`, '6')],
        [
          'unused-template',
          ready(
            'unused-template',
            'ui/unused.rml',
            `<template name="unused"><script>local x = 'unused'</script></template>`,
            '7',
          ),
        ],
      ]),
    };
    const contributionSet = await buildAuthoringDependencyGraphContributionSet(project, {
      mode: 'enabled',
      sources: snapshot,
    });
    const layoutKey = `record:${JSON.stringify(['record', 'layouts', 'hud'])}`;
    const roomKey = `record:${JSON.stringify(['record', 'rooms', 'shared'])}`;
    const scriptKey = `record:${JSON.stringify(['record', 'scripts', 'main'])}`;
    const sourceKey = (assetId: string) =>
      serializeAuthoringDependencyDerivationDependency({ kind: 'source-asset', assetId });
    for (const assetId of ['layout-rml', 'layout-lua', 'external-script', 'template-file'])
      expect(contributionSet.contributionKeysByDerivationKey.get(sourceKey(assetId))).toContain(
        layoutKey,
      );
    expect(contributionSet.contributionKeysByDerivationKey.get(sourceKey('script-file'))).toContain(
      scriptKey,
    );
    expect(contributionSet.contributionKeysByDerivationKey.has(sourceKey('layout-rcss'))).toBe(
      false,
    );
    expect(contributionSet.contributionKeysByDerivationKey.has(sourceKey('shader-file'))).toBe(
      false,
    );
    expect(contributionSet.contributionKeysByDerivationKey.has(sourceKey('unused-script'))).toBe(
      false,
    );
    expect(contributionSet.contributionKeysByDerivationKey.has(sourceKey('unused-template'))).toBe(
      false,
    );
    const ordinaryPropertyKey = serializeAuthoringDependencyDerivationDependency({
      kind: 'property-resolution',
      ownerCollection: 'rooms',
      ownerId: 'shared',
      propertyId: 'ordinary',
    });
    expect(contributionSet.contributionKeysByDerivationKey.has(ordinaryPropertyKey)).toBe(false);
    const explicitPropertyKey = serializeAuthoringDependencyDerivationDependency({
      kind: 'property-resolution',
      ownerCollection: 'rooms',
      ownerId: 'shared',
      propertyId: 'mood',
    });
    expect(contributionSet.contributionKeysByDerivationKey.get(explicitPropertyKey)).toContain(
      layoutKey,
    );
    const localizationKey = serializeAuthoringDependencyDerivationDependency({
      kind: 'localization-lookup',
      key: 'greeting',
    });
    expect(contributionSet.contributionKeysByDerivationKey.get(localizationKey)).toContain(roomKey);
  });

  it('reprojects cached literals after symbol-only changes and derives the same owner contribution', async () => {
    const project = fixture();
    const snapshot: LuaSourceSnapshot = {
      entriesByAssetId: new Map([
        [
          'script-file',
          {
            status: 'ready',
            assetId: 'script-file',
            projectRelativePath: 'scripts/main.lua',
            contentHash: hash('9'),
            text: `'later'`,
            hadUtf8Bom: false,
          },
        ],
      ]),
    };
    const key = `record:${JSON.stringify(['record', 'scripts', 'main'])}`;
    const analyses = (
      await analyzeAuthoringSources(project, snapshot, undefined, new Set([key]))
    ).get(key)!;
    const occurrence = analyses.flatMap((analysis) => analysis.literalOccurrences)[0]!;
    expect(projectAuthoringLiteralEvidence(project, occurrence)).toBeNull();
    const before = reprojectAuthoringDependencyContributionFromCachedSources(
      project,
      key,
      analyses,
    )!;
    expect(before.edges.some((edge) => edge.role === 'lua-possible-reference')).toBe(false);
    project.rooms.later = {
      id: 'later',
      label: 'Later',
      data: defaultRoomData('Later'),
      properties: {},
      traits: [],
    } as never;
    expect(projectAuthoringLiteralEvidence(project, occurrence)?.candidateTargets).toEqual([
      { kind: 'record', collection: 'rooms', id: 'later' },
    ]);
    const selected = reprojectAuthoringDependencyContributionFromCachedSources(
      project,
      key,
      analyses,
    );
    const full = (
      await buildAuthoringDependencyGraphContributionSet(project, {
        mode: 'enabled',
        sources: snapshot,
      })
    ).byKey.get(key);
    expect(selected).toEqual(full);
    expect(selected?.edges.some((edge) => edge.role === 'lua-possible-reference')).toBe(true);
    delete project.rooms.later;
    const afterDelete = reprojectAuthoringDependencyContributionFromCachedSources(
      project,
      key,
      analyses,
    )!;
    expect(afterDelete.edges.some((edge) => edge.role === 'lua-possible-reference')).toBe(false);
    expect(analyses.flatMap((analysis) => analysis.sourceContentFingerprints)).toEqual(
      (await analyzeAuthoringSources(project, snapshot, undefined, new Set([key])))
        .get(key)!
        .flatMap((analysis) => analysis.sourceContentFingerprints),
    );
  });

  it('keeps explicit fallbacks tooling-only and out of compiled gameplay bytes', async () => {
    const project = fixture();
    const layout = defaultLayoutData('HUD');
    layout.script.additionalDependencies = {
      targets: [{ kind: 'record', collection: 'rooms', id: 'shared' }],
    };
    project.layouts.hud = {
      id: 'hud',
      label: 'HUD',
      data: layout,
      properties: {},
      traits: [],
    } as never;
    const graph = await buildAuthoringDependencyGraph(project, { mode: 'disabled' });
    const fallback = [...graph.edgesById.values()].find(
      (edge) => edge.role === 'lua-explicit-reference',
    )!;
    expect(fallback.facets.includes('tooling-reference')).toBe(true);
    expect(fallback.facets.includes('validation')).toBe(true);
    expect(fallback.facets.includes('reference-integrity')).toBe(false);
    expect(fallback.repair).toEqual({
      kind: 'blocked',
      reason: 'Explicit Lua dependency fallback must be updated manually.',
    });
    const before = compileAuthoringProject(project);
    layout.script.additionalDependencies = { targets: [] };
    const after = compileAuthoringProject(project);
    expect(before.ok).toBe(after.ok);
    if (before.ok && after.ok) expect(before.canonicalJson).toBe(after.canonicalJson);
  });

  it('uses the shared fallback-owner registry for validation and graph evidence', async () => {
    const project = createAuthoringProject();
    project.rooms.target = {
      id: 'target',
      label: 'Target',
      data: defaultRoomData('Target'),
      properties: {},
      traits: [],
    } as never;
    const supported = defaultRoomData('Supported');
    supported.description.source = {
      kind: 'lua-expression',
      source: `'target'`,
      additionalDependencies: {
        targets: [{ kind: 'record', collection: 'rooms', id: 'target' }],
      },
    };
    project.rooms.supported = {
      id: 'supported',
      label: 'Supported',
      data: supported,
      properties: {},
      traits: [],
    } as never;
    const unsupported = defaultSceneData('Unsupported');
    const step = defaultSceneStep('run-lua', 'step');
    step.condition = {
      kind: 'lua-predicate',
      source: `'target'`,
      additionalDependencies: {
        targets: [{ kind: 'record', collection: 'rooms', id: 'target' }],
      },
    };
    unsupported.steps = [step];
    project.scenes.unsupported = {
      id: 'unsupported',
      label: 'Unsupported',
      data: unsupported,
      properties: {},
      traits: [],
    } as never;
    const validation = validateAuthoringProject(project);
    expect(
      validation.some(
        (diagnostic) =>
          diagnostic.code === 'authoring.lua.unsupported_explicit_fallback_owner' &&
          diagnostic.path.includes('/scenes/unsupported/'),
      ),
    ).toBe(true);
    expect(
      validation.some(
        (diagnostic) =>
          diagnostic.code === 'authoring.lua.unsupported_explicit_fallback_owner' &&
          diagnostic.path.includes('/rooms/supported/'),
      ),
    ).toBe(false);
    const graph = await buildAuthoringDependencyGraph(project, { mode: 'disabled' });
    const fallbackEdges = [...graph.edgesById.values()].filter(
      (edge) => edge.role === 'lua-explicit-reference',
    );
    expect(fallbackEdges).toHaveLength(1);
    expect(fallbackEdges[0]?.source).toMatchObject({
      kind: 'record',
      collection: 'rooms',
      id: 'supported',
    });
  });

  it('projects property-value fallbacks into correlated definition and owner edges', async () => {
    const project = fixture();
    project.rooms.shared.properties = { mood: 'calm' } as never;
    const layout = defaultLayoutData('HUD');
    layout.script.additionalDependencies = {
      targets: [
        {
          kind: 'property-value',
          owner: { kind: 'room', id: 'shared' },
          propertyId: 'mood',
        },
      ],
    };
    layout.lua.sourceText = `'one' 'two'`;
    project.layouts.hud = {
      id: 'hud',
      label: 'HUD',
      data: layout,
      properties: {},
      traits: [],
    } as never;
    const graph = await buildAuthoringDependencyGraph(project, { mode: 'disabled' });
    const propertyEdges = [...graph.edgesById.values()].filter(
      (edge) =>
        edge.role === 'lua-explicit-reference' &&
        edge.detail?.propertyId === 'mood' &&
        edge.detail.propertyOwnerId === 'shared',
    );
    expect(propertyEdges).toHaveLength(2);
    expect(propertyEdges.map((edge) => edge.target.kind).sort()).toEqual([
      'property-definition',
      'record',
    ]);
    expect(propertyEdges.every((edge) => edge.facets.includes('preview-ui'))).toBe(true);
    const analyses = await analyzeAuthoringSources(
      project,
      {
        entriesByAssetId: new Map([
          [
            'script-file',
            {
              status: 'ready',
              assetId: 'script-file',
              projectRelativePath: 'scripts/main.lua',
              contentHash: hash('1'),
              text: `'shared'`,
              hadUtf8Bom: false,
            },
          ],
        ]),
      },
      {
        ...LUA_REFERENCE_ANALYSIS_LIMITS,
        maxSnapshotBytes: 1,
        maxSnapshotLiteralOccurrences: 1,
        maxLiteralOccurrencesPerSemanticOwner: 1,
      },
    );
    expect(
      [...analyses.values()]
        .flat()
        .flatMap((analysis) => analysis.diagnostics)
        .some((diagnostic) => diagnostic.code === 'authoring.lua.snapshot_byte_limit'),
    ).toBe(true);
  });

  it('uses resolved Trait configuration without materializing property-value nodes', async () => {
    const project = fixture();
    project.properties.mood = {
      id: 'mood',
      label: 'Mood',
      type: 'string',
      nullable: false,
      defaultValue: 'neutral',
      ownerKinds: ['room'],
    };
    project.properties.pose = {
      id: 'pose',
      label: 'Pose',
      type: 'string',
      nullable: false,
      ownerKinds: ['room'],
    };
    project.traits['standing-room'] = {
      id: 'standing-room',
      label: 'Standing Room',
      ownerKinds: ['room'],
      properties: [{ kind: 'configured', propertyId: 'pose', value: 'standing' }],
    };
    project.rooms.child = {
      id: 'child',
      label: 'Child',
      data: defaultRoomData('Child'),
      properties: {},
      traits: ['standing-room'],
    };

    const layout = defaultLayoutData('HUD');
    layout.script.additionalDependencies = {
      targets: [
        {
          kind: 'property-value',
          owner: { kind: 'room', id: 'child' },
          propertyId: 'pose',
        },
      ],
    };
    project.layouts.hud = {
      id: 'hud',
      label: 'HUD',
      data: layout,
      properties: {},
      traits: [],
    } as never;

    const graph = await buildAuthoringDependencyGraph(project, { mode: 'disabled' });
    expect([...graph.nodesByKey.keys()].some((key) => key.includes('property-value'))).toBe(false);
    const ownerEdge = [...graph.edgesById.values()].find(
      (edge) =>
        edge.role === 'lua-explicit-reference' &&
        edge.target.kind === 'record' &&
        edge.target.collection === 'rooms' &&
        edge.target.id === 'child' &&
        edge.detail?.propertyId === 'pose',
    );
    expect(ownerEdge?.targetImpactPaths).toEqual([
      '/rooms/child/properties',
      '/rooms/child/traits',
      '/traits/standing-room',
    ]);
    expect(
      [...graph.edgesById.values()].some(
        (edge) => edge.detail?.propertyId === 'mood' && edge.detail.propertyOwnerId === 'child',
      ),
    ).toBe(false);
  });

  it('enforces per-owner and aggregate occurrence budgets without partial owner snapshots', async () => {
    const ownerProject = createAuthoringProject();
    ownerProject.scripts.main = {
      id: 'main',
      label: 'Main',
      data: {
        kind: 'script-module',
        source: { kind: 'inline-lua', source: `'one' 'two'` },
      },
      properties: {},
      traits: [],
    } as never;
    const ownerKey = `record:${JSON.stringify(['record', 'scripts', 'main'])}`;
    const ownerLimited = (
      await analyzeAuthoringSources(
        ownerProject,
        { entriesByAssetId: new Map() },
        {
          ...LUA_REFERENCE_ANALYSIS_LIMITS,
          maxLiteralOccurrencesPerSemanticOwner: 1,
        },
      )
    ).get(ownerKey)!;
    expect(ownerLimited.flatMap((analysis) => analysis.literalOccurrences)).toEqual([]);
    expect(
      ownerLimited
        .flatMap((analysis) => analysis.diagnostics)
        .some((diagnostic) => diagnostic.code === 'authoring.lua.owner_occurrence_limit'),
    ).toBe(true);

    const aggregateProject = createAuthoringProject();
    for (const id of ['a', 'b'])
      aggregateProject.scripts[id] = {
        id,
        label: id,
        data: {
          kind: 'script-module',
          source: { kind: 'inline-lua', source: `'${id}'` },
        },
        properties: {},
        traits: [],
      } as never;
    const aggregate = await analyzeAuthoringSources(
      aggregateProject,
      { entriesByAssetId: new Map() },
      {
        ...LUA_REFERENCE_ANALYSIS_LIMITS,
        maxSnapshotLiteralOccurrences: 1,
      },
    );
    const firstKey = `record:${JSON.stringify(['record', 'scripts', 'a'])}`;
    const secondKey = `record:${JSON.stringify(['record', 'scripts', 'b'])}`;
    expect(
      aggregate.get(firstKey)!.flatMap((analysis) => analysis.literalOccurrences),
    ).toHaveLength(1);
    expect(aggregate.get(secondKey)!.flatMap((analysis) => analysis.literalOccurrences)).toEqual(
      [],
    );
    expect(
      aggregate
        .get(secondKey)!
        .flatMap((analysis) => analysis.diagnostics)
        .some((diagnostic) => diagnostic.code === 'authoring.lua.snapshot_occurrence_limit'),
    ).toBe(true);
  });

  it('counts one shared physical source once across semantic owners', async () => {
    const project = createAuthoringProject();
    project.assets.shared = {
      id: 'shared',
      label: 'Shared source',
      data: {
        kind: 'script',
        source: { type: 'project-file', path: 'scripts/shared.lua' },
        aliases: [],
        contentHash: hash('7'),
        imageMetadata: null,
      },
      properties: {},
      traits: [],
    } as never;
    project.scripts.main = {
      id: 'main',
      label: 'Main',
      data: {
        kind: 'script-module',
        source: { kind: 'asset', asset: { $ref: { collection: 'assets', id: 'shared' } } },
      },
      properties: {},
      traits: [],
    } as never;
    const room = defaultRoomData('Room');
    room.compose = {
      script: { $ref: { collection: 'scripts', id: 'main' } },
      additionalDependencies: { targets: [] },
    };
    project.rooms.room = {
      id: 'room',
      label: 'Room',
      data: room,
      properties: {},
      traits: [],
    } as never;
    const text = `'shared'`;
    const analyses = await analyzeAuthoringSources(
      project,
      {
        entriesByAssetId: new Map([
          [
            'shared',
            {
              status: 'ready',
              assetId: 'shared',
              projectRelativePath: 'scripts/shared.lua',
              contentHash: hash('7'),
              text,
              hadUtf8Bom: false,
            },
          ],
        ]),
      },
      {
        ...LUA_REFERENCE_ANALYSIS_LIMITS,
        maxSnapshotBytes: new TextEncoder().encode(text).byteLength,
      },
    );
    expect(
      [...analyses.values()].filter(
        (items) => items.flatMap((analysis) => analysis.literalOccurrences).length === 1,
      ),
    ).toHaveLength(2);
    expect(
      [...analyses.values()]
        .flat()
        .flatMap((analysis) => analysis.diagnostics)
        .some((diagnostic) => diagnostic.code === 'authoring.lua.snapshot_byte_limit'),
    ).toBe(false);
  });

  it('marks a source incomplete when its individual byte limit is exceeded', async () => {
    const artifact = await analyzeAuthoringSourceContent({
      sourceUrl: 'authoring:inline-lua',
      kind: 'lua',
      text: `'too large'`,
      limits: { maxSourceBytes: 1, maxEmbeddedListenerDepth: 1 },
    });
    expect(artifact.complete).toBe(false);
    expect(artifact.literalOccurrences).toEqual([]);
    expect(artifact.diagnostics[0]?.code).toBe('authoring.lua.source_limit');
  });

  it('records the enabled representative full-graph benchmark', async () => {
    const project = fixture();
    for (let index = 0; index < 300; index += 1)
      project.rooms[`room-${index}`] = {
        id: `room-${index}`,
        label: `Room ${index}`,
        data: {
          kind: 'room',
          description: { source: { kind: 'lua-expression', source: `'shared'` } },
        },
        properties: {},
        traits: [],
      } as never;
    const snapshot: LuaSourceSnapshot = {
      entriesByAssetId: new Map([
        [
          'script-file',
          {
            status: 'ready',
            assetId: 'script-file',
            projectRelativePath: 'scripts/main.lua',
            contentHash: hash('1'),
            text: `'shared'`,
            hadUtf8Bom: false,
          },
        ],
      ]),
    };
    const started = performance.now();
    const graph = await buildAuthoringDependencyGraph(project, {
      mode: 'enabled',
      sources: snapshot,
    });
    const elapsedMs = performance.now() - started;
    console.info(
      `AUTHORING_ENABLED_GRAPH_BENCHMARK rooms=300 nodes=${graph.nodesByKey.size} edges=${graph.edgesById.size} elapsedMs=${elapsedMs.toFixed(2)}`,
    );
    expect(graph.nodesByKey.size).toBeGreaterThan(300);
    expect(elapsedMs).toBeLessThan(10_000);
  });
});
