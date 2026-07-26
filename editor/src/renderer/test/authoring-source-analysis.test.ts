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
  deriveAuthoringDependencyContribution,
  enumerateAuthoringDependencyContributionKeys,
  projectAuthoringLiteralEvidence,
} from '../../shared/authoring-dependency-graph';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  LUA_REFERENCE_ANALYSIS_LIMITS,
  type LuaSourceSnapshot,
} from '../../shared/project-schema/authoring-lua-analysis';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { compileAuthoringProject } from '../../shared/authoring-compiler';

const hash = (digit: string) => `sha256:${digit.repeat(64)}` as const;

describe('authoring Lua lexer', () => {
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
});

describe('RML Lua extraction', () => {
  it('uses decoded event attributes and original raw script bytes', () => {
    const artifact = analyzeAuthoringSourceContent({
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

  it('recognizes direct listener/load strings with parent provenance', () => {
    const artifact = analyzeAuthoringSourceContent({
      sourceUrl: 'authoring:/startupHook/source',
      kind: 'lua',
      text: `element:AddEventListener('click', "open('room-main')")\nload("return 'asset-main'")`,
    });
    expect(artifact.regions.some((region) => region.sourceKind === 'lua-load-string')).toBe(true);
    expect(
      artifact.regions
        .filter((region) => region.parentRegionOrdinal !== undefined)
        .every((region) => region.parentRegionOrdinal === 0),
    ).toBe(true);
  });

  it('warns for malformed raw-text containers without suppressing prior regions', () => {
    const artifact = analyzeAuthoringSourceContent({
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
      extends: null,
    } as never;
    project.assets.shared = {
      id: 'shared',
      label: 'Shared asset',
      data: { kind: 'image', path: 'shared.png' },
      properties: {},
      extends: null,
    } as never;
    project.assets['script-file'] = {
      id: 'script-file',
      label: 'Script',
      data: { kind: 'script', path: 'scripts/main.lua', extension: '.lua', contentHash: hash('1') },
      properties: {},
      extends: null,
    } as never;
    project.scripts.main = {
      id: 'main',
      label: 'Main',
      data: {
        kind: 'script-module',
        source: { kind: 'asset', asset: { $ref: { collection: 'assets', id: 'script-file' } } },
      },
      properties: {},
      extends: null,
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
      extends: null,
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
    const surfaces = [
      ['scenes', 'scene', { program: [{ kind: 'run-lua', source: 'scene()' }] }],
      [
        'dialogues',
        'dialogue',
        { blocks: [{ segments: [{ kind: 'run-lua', source: 'dialogue()' }] }] },
      ],
      ['verbs', 'verb', { availability: { kind: 'lua-predicate', source: 'verb()' } }],
      [
        'interactions',
        'interaction',
        { rules: [{ effect: { kind: 'run-lua-effect', source: 'interaction()' } }] },
      ],
      ['tests', 'test', { steps: [{ condition: { kind: 'lua-predicate', source: 'test()' } }] }],
      ['characters', 'character', { text: { kind: 'lua-expression', source: 'character()' } }],
      [
        'interactables',
        'interactable',
        { condition: { kind: 'lua-predicate', source: 'interactable()' } },
      ],
      ['maps', 'map', { label: { kind: 'lua-expression', source: 'map()' } }],
    ] as const;
    for (const [collection, id, data] of surfaces)
      project[collection][id] = {
        id,
        label: id,
        data,
        properties: {},
        extends: null,
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
  });

  it('keeps content artifacts owner-neutral and cheaply rebinds provenance', () => {
    const artifact = analyzeAuthoringSourceContent({
      sourceUrl: 'asset:script-file',
      kind: 'lua',
      text: `'shared'`,
      contentHash: hash('1'),
    });
    const project = fixture();
    const descriptor = collectAuthoringLuaSources(project).find(
      (source) =>
        source.contributionKey === `record:${JSON.stringify(['record', 'scripts', 'main'])}`,
    )!;
    const rebound = bindAuthoringSourceOwner(descriptor, [artifact]);
    expect(artifact.literalOccurrences[0]).not.toHaveProperty('sourcePath');
    expect(rebound.literalOccurrences[0]?.sourcePath).toBe('/scripts/main/data/source/asset/$ref');
  });

  it('adds ambiguous lexical tooling evidence only in enabled mode', () => {
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
    const disabled = buildAuthoringDependencyGraph(project, { mode: 'disabled' });
    const enabled = buildAuthoringDependencyGraph(project, { mode: 'enabled', sources: snapshot });
    expect(
      [...disabled.edgesById.values()].some((edge) => edge.role === 'lua-possible-reference'),
    ).toBe(false);
    const luaEdges = [...enabled.edgesById.values()].filter(
      (edge) => edge.role === 'lua-possible-reference',
    );
    expect(luaEdges.length).toBeGreaterThanOrEqual(4);
    expect(luaEdges.every((edge) => !edge.facets.includes('reference-integrity'))).toBe(true);
    expect(
      luaEdges.some(
        (edge) =>
          edge.evidence?.[0]?.kind === 'lua-occurrence' &&
          edge.evidence[0].occurrence.candidateTargets.length === 2,
      ),
    ).toBe(true);
  });

  it('uses deterministic contribution keys and graph ordering', () => {
    const project = fixture();
    const keys = enumerateAuthoringDependencyContributionKeys(project);
    expect(keys).toEqual([...keys].sort());
    const left = buildAuthoringDependencyGraph(project, { mode: 'disabled' });
    const right = buildAuthoringDependencyGraph(structuredClone(project), { mode: 'disabled' });
    expect([...left.edgesById.keys()]).toEqual([...right.edgesById.keys()]);
  });

  it('resolves declared external scripts and a cycle-safe transitive template closure', () => {
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
        },
        properties: {},
        extends: null,
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
      extends: null,
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
    const analyses = analyzeAuthoringSources(project, snapshot).get(
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
    expect(analyses.flatMap((item) => item.diagnostics)).toEqual([]);
  });

  it('reprojects cached literals after symbol-only changes and derives the same owner contribution', () => {
    const project = fixture();
    const occurrence = analyzeAuthoringSourceContent({
      sourceUrl: 'authoring:/startupHook/source',
      kind: 'lua',
      text: `'later'`,
    }).literalOccurrences[0]!;
    const boundOccurrence = {
      ...occurrence,
      sourcePath: '/startupHook/source',
    };
    expect(projectAuthoringLiteralEvidence(project, boundOccurrence)).toBeNull();
    project.rooms.later = {
      id: 'later',
      label: 'Later',
      data: { kind: 'room' },
      properties: {},
      extends: null,
    } as never;
    expect(projectAuthoringLiteralEvidence(project, boundOccurrence)?.candidateTargets).toEqual([
      { kind: 'record', collection: 'rooms', id: 'later' },
    ]);
    const key = `record:${JSON.stringify(['record', 'rooms', 'later'])}`;
    const selected = deriveAuthoringDependencyContribution(project, key);
    const full = buildAuthoringDependencyGraphContributionSet(project, {
      mode: 'disabled',
    }).byKey.get(key);
    expect(selected).toEqual(full);
  });

  it('keeps explicit fallbacks tooling-only and out of compiled gameplay bytes', () => {
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
      extends: null,
    } as never;
    const graph = buildAuthoringDependencyGraph(project, { mode: 'disabled' });
    const fallback = [...graph.edgesById.values()].find(
      (edge) => edge.role === 'lua-explicit-reference',
    )!;
    expect(fallback.facets).toEqual(['tooling-reference', 'validation']);
    const before = compileAuthoringProject(project);
    layout.script.additionalDependencies = { targets: [] };
    const after = compileAuthoringProject(project);
    expect(before.ok).toBe(after.ok);
    if (before.ok && after.ok) expect(before.canonicalJson).toBe(after.canonicalJson);
  });

  it('uses dedicated property-value targets and emits deterministic truncation diagnostics', () => {
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
      extends: null,
    } as never;
    const graph = buildAuthoringDependencyGraph(project, { mode: 'disabled' });
    expect(
      [...graph.edgesById.values()].some(
        (edge) => edge.role === 'lua-explicit-reference' && edge.target.kind === 'property-value',
      ),
    ).toBe(true);
    const analyses = analyzeAuthoringSources(
      project,
      { entriesByAssetId: new Map() },
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
        .some((diagnostic) => diagnostic.code === 'authoring.lua.snapshot_limit'),
    ).toBe(true);
  });

  it('records the enabled representative full-graph benchmark', () => {
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
        extends: null,
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
    const graph = buildAuthoringDependencyGraph(project, { mode: 'enabled', sources: snapshot });
    const elapsedMs = performance.now() - started;
    console.info(
      `AUTHORING_ENABLED_GRAPH_BENCHMARK rooms=300 nodes=${graph.nodesByKey.size} edges=${graph.edgesById.size} elapsedMs=${elapsedMs.toFixed(2)}`,
    );
    expect(graph.nodesByKey.size).toBeGreaterThan(300);
    expect(elapsedMs).toBeLessThan(10_000);
  });
});
