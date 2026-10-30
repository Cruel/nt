import { describe, expect, it, vi } from 'vite-plus/test';
import {
  nativeGraphCommandPreflight,
  nativeGraphImpactedOwnerPaths,
  nativeGraphReferenceSearch,
  nativeGraphUsageCounts,
  nativeGraphUsages,
  requireNativeGraphPreflight,
} from '../../main/services/native-semantic-graph-queries';
import {
  nativeSemanticGraphSchema,
  type NativeSemanticGraph,
} from '../../main/services/native-authoring-worker-contract';
import { projectNativeGraphForRenderer } from '../project/native-authoring-graph-projection';
import {
  preflightGraphCommand,
  semanticUsagesForTarget,
} from '../project/authoring-graph-consumers';
import { generateAuthoringRepairPlan } from '../project/authoring-repair';
import { referenceIndexFromCurrentGraph } from '../project/authoring-graph-consumers';
import {
  authoringProjectSchema,
  createAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { buildProjectSearchIndex } from '../../shared/project-search/project-search-index';
import { searchProjectIndex } from '../../shared/project-search/project-search';
import { entityRenameIdCommand } from '../commands/builtin-commands';
import { toJsonValue } from '../project/json-value';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

const origin = { kind: 'record' as const, collection: 'rooms', id: 'foyer' };
const target = { kind: 'record' as const, collection: 'assets' as const, id: 'backdrop' };
const first = {
  ownerPath: '/rooms/foyer',
  sourceUrl: 'project:/scripts/room-hook.lua',
  sourceRevision: 'sha256:' + '1'.repeat(64),
  line: 2,
  column: 10,
  startUtf16: 12,
  endUtf16: 22,
  value: 'backdrop',
  target,
} as const;

const fixture: NativeSemanticGraph = nativeSemanticGraphSchema.parse({
  projectSessionId: 'admitted-A',
  generation: 1,
  workingRevision: 7,
  sourceRevisions: { 'project.yaml': 'sha256:' + '2'.repeat(64) },
  textSourceRevisions: { 'scripts/room-hook.lua': first.sourceRevision },
  complete: true,
  incompleteOwners: [],
  nodes: [
    { key: origin, keyText: JSON.stringify(origin), owningPath: '/rooms/foyer', label: 'Foyer' },
    {
      key: target,
      keyText: JSON.stringify(target),
      owningPath: '/assets/backdrop',
      label: 'Backdrop',
    },
  ],
  edges: [
    {
      id: 'room-backdrop',
      source: origin,
      target,
      sourcePath: '/rooms/foyer/data/background/asset',
      targetPath: '/assets/backdrop',
      role: 'room-background',
      facets: ['reference-integrity', 'tooling-reference', 'preview-visual', 'resource'],
      targetImpactPaths: ['/assets/backdrop/data/source/path'],
      repair: { kind: 'blocked', reason: 'Author chooses a replacement.' },
    },
  ],
  occurrences: [
    {
      ...first,
      classification: 'exact-rewriteable',
      recognizedBy: 'native.Text.msg',
      rewriteRange: { startUtf16: 12, endUtf16: 22, expectedText: '"backdrop"' },
    },
    { ...first, classification: 'exact-manual', sourceUrl: 'project:/assets/splash.rml' },
    { ...first, classification: 'possible-lexical', value: 'backdrop', line: 20 },
  ],
  diagnostics: [],
});

describe('revision-pinned native graph presentation-only queries', () => {
  it('renames a flow target with its native wire shape, even when deletion repair is blocked', () => {
    const project = createAuthoringProject();
    project.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };
    project.entrypoint = { kind: 'room', id: 'hall' };
    const room = { kind: 'record' as const, collection: 'rooms' as const, id: 'hall' };
    const entry = { kind: 'project-field' as const, path: '/entrypoint' };
    const native = projectNativeGraphForRenderer(
      nativeSemanticGraphSchema.parse({
        ...fixture,
        nodes: [
          { key: room, keyText: JSON.stringify(room), owningPath: '/rooms/hall', label: 'Hall' },
          { key: entry, keyText: JSON.stringify(entry), owningPath: '/entrypoint', label: 'Entry' },
        ],
        edges: [
          {
            id: 'flow',
            source: entry,
            target: room,
            sourcePath: '/entrypoint',
            targetPath: '/rooms/hall',
            role: 'flow-target',
            facets: ['reference-integrity', 'tooling-reference'],
            targetImpactPaths: ['/rooms/hall'],
            repair: { kind: 'blocked', reason: 'Cannot repair deletion.' },
          },
        ],
        occurrences: [],
      }),
      'flow-rename',
      1,
    );
    const document = toJsonValue(project);
    // A native-admitted projection is not subject to a second whole-Project
    // TS schema parse. Unknown unrelated fields do not erase references.
    (document as Record<string, unknown>).nativeOnlySentinel = true;
    const schemaParse = vi.spyOn(authoringProjectSchema, 'safeParse');
    let result: ReturnType<typeof entityRenameIdCommand>;
    try {
      result = entityRenameIdCommand({
        document,
        savedDocument: null,
        graphSnapshot: native,
        projectInstanceId: 'flow-rename',
        projectRevision: 1,
        payload: { collection: 'rooms', fromId: 'hall', toId: 'new-hall' },
        request: {} as never,
      });
      expect(schemaParse).not.toHaveBeenCalled();
    } finally {
      schemaParse.mockRestore();
    }
    expect(result.diagnostics?.filter((item) => item.severity === 'error') ?? []).toEqual([]);
    expect(result.patches).toContainEqual({
      op: 'replace',
      path: '/entrypoint',
      value: { kind: 'room', id: 'new-hall' },
    });
    expect(result.patches).toContainEqual({ op: 'remove', path: '/rooms/hall' });
  });

  it('requires confirmation for physical references and counts each occurrence only once', () => {
    const project = createAuthoringProject();
    project.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };
    const room = { kind: 'record' as const, collection: 'rooms' as const, id: 'hall' };
    const script = { kind: 'record' as const, collection: 'scripts' as const, id: 'bootstrap' };
    const sourceOnly = projectNativeGraphForRenderer(
      nativeSemanticGraphSchema.parse({
        ...fixture,
        nodes: [
          { key: room, keyText: JSON.stringify(room), owningPath: '/rooms/hall', label: 'Hall' },
          {
            key: script,
            keyText: JSON.stringify(script),
            owningPath: '/scripts/bootstrap',
            label: 'Bootstrap',
          },
        ],
        edges: [
          {
            id: 'aggregate',
            source: script,
            target: room,
            sourcePath: '/scripts/bootstrap',
            targetPath: '/rooms/hall',
            role: 'source-recognized-reference',
            facets: ['reference-integrity', 'tooling-reference', 'resource'],
            targetImpactPaths: ['/rooms/hall'],
            repair: { kind: 'blocked', reason: 'Source text requires review.' },
          },
        ],
        occurrences: [
          {
            ownerPath: '/scripts/bootstrap',
            sourceUrl: 'project:/scripts/bootstrap.lua',
            sourceRevision: 'sha256:' + '5'.repeat(64),
            line: 3,
            column: 9,
            value: 'hall',
            classification: 'exact-manual',
            target: room,
          },
        ],
      }),
      'source-rename',
      1,
    );
    expect(semanticUsagesForTarget(sourceOnly, room)).toHaveLength(1);
    expect(nativeGraphUsageCounts(sourceOnly.nativeGraph, room)).toEqual({
      confirmed: 0,
      possible: 0,
      recognized: 1,
    });
    const base = {
      document: toJsonValue(project),
      savedDocument: null,
      graphSnapshot: sourceOnly,
      projectInstanceId: 'source-rename',
      projectRevision: 1,
      request: {} as never,
    };
    const blocked = entityRenameIdCommand({
      ...base,
      payload: { collection: 'rooms', fromId: 'hall', toId: 'new-hall' },
    });
    expect(blocked.patches).toEqual([]);
    expect(blocked.diagnostics).toEqual([expect.objectContaining({ severity: 'error' })]);
    const confirmed = entityRenameIdCommand({
      ...base,
      payload: {
        collection: 'rooms',
        fromId: 'hall',
        toId: 'new-hall',
        confirmRenameWithoutLuaRewrite: true,
      },
    });
    expect(confirmed.diagnostics?.filter((item) => item.severity === 'error') ?? []).toEqual([]);
    expect(confirmed.patches).toEqual(
      expect.arrayContaining([expect.objectContaining({ op: 'remove', path: '/rooms/hall' })]),
    );
    expect(confirmed.patches.some((patch) => patch.path === '/scripts/bootstrap')).toBe(false);
  });

  it('refuses a native reference edge whose admitted field no longer matches its target', () => {
    const project = createAuthoringProject();
    project.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };
    project.entrypoint = { kind: 'scene', id: 'intro' };
    const room = { kind: 'record' as const, collection: 'rooms' as const, id: 'hall' };
    const entry = { kind: 'project-field' as const, path: '/entrypoint' };
    const native = projectNativeGraphForRenderer(
      nativeSemanticGraphSchema.parse({
        ...fixture,
        nodes: [
          { key: room, keyText: JSON.stringify(room), owningPath: '/rooms/hall', label: 'Hall' },
          { key: entry, keyText: JSON.stringify(entry), owningPath: '/entrypoint', label: 'Entry' },
        ],
        edges: [
          {
            id: 'stale-field',
            source: entry,
            target: room,
            sourcePath: '/entrypoint',
            targetPath: '/rooms/hall',
            role: 'flow-target',
            facets: ['reference-integrity'],
            targetImpactPaths: ['/rooms/hall'],
            repair: { kind: 'blocked', reason: 'Deletion not supported.' },
          },
        ],
        occurrences: [],
      }),
      'stale-rename',
      1,
    );
    const result = entityRenameIdCommand({
      document: toJsonValue(project),
      savedDocument: null,
      graphSnapshot: native,
      projectInstanceId: 'stale-rename',
      projectRevision: 1,
      payload: { collection: 'rooms', fromId: 'hall', toId: 'new-hall' },
      request: {} as never,
    });
    expect(result.patches).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('no proven safe rename encoding'),
      }),
    ]);
  });

  it('allows safe native Variable and entrypoint rename patches despite blocked delete repair descriptors', () => {
    const variable = { kind: 'record' as const, collection: 'variables' as const, id: 'score' };
    const dialogue = { kind: 'record' as const, collection: 'dialogues', id: 'intro' };
    const room = { kind: 'record' as const, collection: 'rooms' as const, id: 'hall' };
    const entrypoint = { kind: 'project-field' as const, path: '/entrypoint' };
    const snapshot = projectNativeGraphForRenderer(
      nativeSemanticGraphSchema.parse({
        ...fixture,
        occurrences: [],
        nodes: [
          {
            key: variable,
            keyText: JSON.stringify(variable),
            owningPath: '/variables/score',
            label: 'Score',
          },
          {
            key: dialogue,
            keyText: JSON.stringify(dialogue),
            owningPath: '/dialogues/intro',
            label: 'Intro',
          },
          { key: room, keyText: JSON.stringify(room), owningPath: '/rooms/hall', label: 'Hall' },
          {
            key: entrypoint,
            keyText: JSON.stringify(entrypoint),
            owningPath: '/entrypoint',
            label: 'Entry',
          },
        ],
        edges: [
          {
            id: 'var',
            source: dialogue,
            target: variable,
            sourcePath: '/dialogues/intro/data/condition/$var',
            targetPath: '/variables/score',
            role: 'variable-ref',
            facets: ['reference-integrity', 'tooling-reference'],
            targetImpactPaths: ['/variables/score'],
            repair: { kind: 'blocked', reason: 'Delete requires review' },
          },
          {
            id: 'entry',
            source: entrypoint,
            target: room,
            sourcePath: '/entrypoint',
            targetPath: '/rooms/hall',
            role: 'entrypoint',
            facets: ['reference-integrity', 'tooling-reference'],
            targetImpactPaths: ['/rooms/hall'],
            repair: { kind: 'blocked', reason: 'Delete requires review' },
          },
        ],
      }),
      'renderer-A',
      17,
    );
    for (const target of [variable, room])
      expect(
        preflightGraphCommand({
          snapshot,
          projectInstanceId: 'renderer-A',
          projectRevision: 17,
          target,
          operation: 'rename',
        }),
      ).toMatchObject({ kind: 'ready' });
  });
  it('retains native localization-message identity, physical source locations and manual rewrite classification', () => {
    const message = {
      kind: 'localization-message' as const,
      locale: 'en',
      messageId: 'lab.greeting',
    };
    const script = { kind: 'record' as const, collection: 'scripts', id: 'story' };
    const localized = nativeSemanticGraphSchema.parse({
      ...fixture,
      nodes: [
        {
          key: message,
          keyText: JSON.stringify(message),
          owningPath: '/localization/messages/lab.greeting/source',
          label: 'Greeting',
        },
        {
          key: script,
          keyText: JSON.stringify(script),
          owningPath: '/scripts/story',
          label: 'Story',
        },
      ],
      edges: [],
      occurrences: [
        {
          ownerPath: '/scripts/story',
          sourceUrl: 'project:/scripts/story.lua',
          sourceRevision: 'sha256:' + 'a'.repeat(64),
          line: 9,
          column: 18,
          value: 'lab.greeting',
          classification: 'exact-manual',
          recognizedBy: 'native.Text.msg',
          target: message,
        },
        {
          ownerPath: '/scripts/story',
          sourceUrl: 'project:/scripts/story.lua',
          sourceRevision: 'sha256:' + 'a'.repeat(64),
          line: 14,
          column: 6,
          value: 'lab.greeting',
          classification: 'possible-lexical',
          target: message,
        },
      ],
    });
    const projection = projectNativeGraphForRenderer(localized, 'locale-project', 7);
    expect(semanticUsagesForTarget(projection, message)).toEqual([
      expect.objectContaining({
        sourcePath: 'project:/scripts/story.lua',
        sourceReferenceClassification: 'exact-manual',
        sourceLocation: { line: 9, column: 18, endLine: 9, endColumn: 30 },
      }),
      expect.objectContaining({
        sourceReferenceClassification: 'possible-lexical',
        sourceLocation: { line: 14, column: 6, endLine: 14, endColumn: 18 },
      }),
    ]);
    expect(nativeGraphUsageCounts(localized, message)).toEqual({
      confirmed: 0,
      recognized: 1,
      possible: 1,
    });
  });
  it('accepts an authored nullable reference repair and safe structured rename without guessing source bytes', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.background.asset = { $ref: { collection: 'assets', id: 'backdrop' } };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.assets.backdrop = {
      id: 'backdrop',
      label: 'Backdrop',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/backdrop.png' },
        aliases: [],
        extension: '.png',
        imageMetadata: { width: 640, height: 480, hasAlpha: false, orientation: 1 },
      },
    };
    const repairable: NativeSemanticGraph = {
      ...fixture,
      occurrences: [],
      edges: [
        {
          ...fixture.edges[0]!,
          sourcePath: '/rooms/foyer/data/background/asset/$ref',
          repair: { kind: 'set-null', path: '/rooms/foyer/data/background/asset' },
        },
      ],
    };
    const snapshot = projectNativeGraphForRenderer(repairable, 'renderer-A', 17);
    const plan = generateAuthoringRepairPlan({
      snapshot,
      projectInstanceId: 'renderer-A',
      projectRevision: 17,
      target,
      deletePath: '/assets/backdrop',
    });
    expect(plan).toMatchObject({
      status: 'ready',
      plan: {
        patches: expect.arrayContaining([
          { op: 'replace', path: '/rooms/foyer/data/background/asset', value: null },
          { op: 'remove', path: '/assets/backdrop' },
        ]),
      },
    });
    const renamed = entityRenameIdCommand({
      document: toJsonValue(project),
      savedDocument: null,
      graphSnapshot: snapshot,
      projectInstanceId: 'renderer-A',
      projectRevision: 17,
      payload: { collection: 'assets', fromId: 'backdrop', toId: 'sky' },
      request: {
        type: 'entity.renameId',
        payload: {},
        originSaveUnitId: 'record:assets:backdrop',
        persistencePolicy: 'manual-save',
      },
    });
    expect(renamed.diagnostics?.filter((item) => item.severity === 'error') ?? []).toEqual([]);
    expect(renamed.patches).toContainEqual({
      op: 'replace',
      path: '/rooms/foyer/data/background/asset/$ref',
      value: { collection: 'assets', id: 'sky' },
    });
    const blockingRepair = projectNativeGraphForRenderer(
      {
        ...repairable,
        edges: [
          {
            ...repairable.edges[0]!,
            repair: { kind: 'blocked', reason: 'Delete cannot be repaired.' },
          },
        ],
      },
      'renderer-A',
      17,
    );
    const renameThroughStructuredReference = entityRenameIdCommand({
      document: toJsonValue(project),
      savedDocument: null,
      graphSnapshot: blockingRepair,
      projectInstanceId: 'renderer-A',
      projectRevision: 17,
      payload: { collection: 'assets', fromId: 'backdrop', toId: 'sky' },
      request: {
        type: 'entity.renameId',
        payload: {},
        originSaveUnitId: 'record:assets:backdrop',
        persistencePolicy: 'manual-save',
      },
    });
    expect(renameThroughStructuredReference.patches).toContainEqual({
      op: 'replace',
      path: '/rooms/foyer/data/background/asset/$ref',
      value: { collection: 'assets', id: 'sky' },
    });
  });
  it('indexes Project Search references from native edges without deriving a TypeScript graph', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: {} as never };
    project.assets.backdrop = { id: 'backdrop', label: 'Backdrop', data: {} as never };
    const native = projectNativeGraphForRenderer(fixture, 'search-A', 1);
    const index = buildProjectSearchIndex(project, {
      referenceIndex: referenceIndexFromCurrentGraph(project, native),
    });
    const results = searchProjectIndex(index, {
      referencesTo: [{ collection: 'assets', id: 'backdrop' }],
      tokenMode: 'all',
      sort: { kind: 'label' },
    });
    expect(results.results.map((item) => item.document.id)).toContain('record:rooms:foyer');
  });
  it('projects native structural edges and distinct physical-source evidence for real renderer consumers', () => {
    const snapshot = projectNativeGraphForRenderer(fixture, 'renderer-A', 17);
    const usages = semanticUsagesForTarget(snapshot, target);
    expect(usages.map((usage) => usage.role)).toEqual([
      'room-background',
      'source-recognized-reference',
      'source-recognized-reference',
      'lua-possible-reference',
    ]);
    expect(usages.map((usage) => usage.sourceReferenceClassification).filter(Boolean)).toEqual(
      expect.arrayContaining(['exact-rewriteable', 'exact-manual', 'possible-lexical']),
    );
    const input = {
      snapshot,
      projectInstanceId: 'renderer-A',
      projectRevision: 17,
      target,
    };
    expect(preflightGraphCommand({ ...input, operation: 'rename' })).toMatchObject({
      kind: 'blocked',
    });
    expect(
      preflightGraphCommand({
        ...input,
        operation: 'rename',
        confirmRenameWithoutLuaRewrite: true,
      }),
    ).toMatchObject({
      kind: 'ready',
      warnings: expect.any(Array),
    });
    const sourceOnly = projectNativeGraphForRenderer({ ...fixture, edges: [] }, 'renderer-A', 17);
    expect(
      preflightGraphCommand({
        ...input,
        snapshot: sourceOnly,
        operation: 'rename',
        confirmRenameWithoutLuaRewrite: true,
      }),
    ).toMatchObject({
      kind: 'ready',
      usages: expect.arrayContaining([
        expect.objectContaining({ sourceReferenceClassification: 'exact-manual' }),
      ]),
    });
    expect(
      generateAuthoringRepairPlan({
        ...input,
        deletePath: '/assets/backdrop',
      }),
    ).toMatchObject({ status: 'blocked' });
    expect(
      generateAuthoringRepairPlan({
        ...input,
        deletePath: '/assets/backdrop',
        force: true,
      }),
    ).toMatchObject({ status: 'ready', plan: { warnings: expect.any(Array) } });
    expect(() =>
      projectNativeGraphForRenderer(
        { ...fixture, complete: false, incompleteOwners: ['rooms/foyer'] },
        'renderer-A',
        17,
      ),
    ).toThrow('incomplete');
  });
  it('keeps structural, exact manual, exact rewriteable and speculative evidence separate', () => {
    const usages = nativeGraphUsages(fixture, target);
    expect(nativeGraphUsageCounts(fixture, target)).toEqual({
      confirmed: 1,
      possible: 1,
      recognized: 2,
    });
    expect(usages.confirmed.map((item) => item.role)).toEqual(['room-background']);
    expect(usages.recognized.map((item) => item.classification)).toEqual([
      'exact-rewriteable',
      'exact-manual',
    ]);
    expect(usages.possible.map((item) => item.classification)).toEqual(['possible-lexical']);
  });

  it('fails closed on wrong session, stale revision or incomplete graph', () => {
    expect(() => requireNativeGraphPreflight(fixture, 'other', 7, 1)).toThrow();
    expect(() => requireNativeGraphPreflight(fixture, 'admitted-A', 6, 1)).toThrow();
    expect(() => requireNativeGraphPreflight(fixture, 'admitted-A', 7, 2)).toThrow();
    expect(() =>
      requireNativeGraphPreflight(
        { ...fixture, complete: false, incompleteOwners: ['rooms/invalid'] },
        'admitted-A',
        7,
        1,
      ),
    ).toThrow();
    expect(requireNativeGraphPreflight(fixture, 'admitted-A', 7, 1)).toBe(fixture);
  });

  it('blocks non-forced deletion and manual source rename, retaining lexical warnings', () => {
    const input = {
      graph: fixture,
      projectSessionId: 'admitted-A',
      workingRevision: 7,
      workerGeneration: 1,
      target,
    };
    expect(nativeGraphCommandPreflight({ ...input, operation: 'delete' })).toMatchObject({
      kind: 'blocked',
      manual: [{ classification: 'exact-manual' }],
      warnings: [{ classification: 'possible-lexical' }],
    });
    expect(nativeGraphCommandPreflight({ ...input, operation: 'rename' })).toMatchObject({
      kind: 'blocked',
    });
    expect(
      nativeGraphCommandPreflight({ ...input, operation: 'rename', confirmManualRename: true }),
    ).toMatchObject({
      kind: 'ready',
      confirmed: [{ role: 'room-background' }],
    });
    expect(
      nativeGraphCommandPreflight({
        ...input,
        graph: { ...fixture, edges: [] },
        operation: 'rename',
        confirmManualRename: true,
      }),
    ).toMatchObject({
      kind: 'ready',
      rewriteable: [{ classification: 'exact-rewriteable' }],
    });
    expect(
      nativeGraphCommandPreflight({ ...input, operation: 'delete', forceDelete: true }),
    ).toMatchObject({
      kind: 'ready',
    });
  });

  it('uses only native impact fields and Project-relative search evidence', () => {
    expect(
      nativeGraphImpactedOwnerPaths(
        fixture,
        ['/assets/backdrop/data/source/path'],
        'preview-visual',
      ),
    ).toEqual(['/rooms/foyer']);
    expect(
      nativeGraphImpactedOwnerPaths(fixture, ['/assets/backdrop/label'], 'preview-visual'),
    ).toEqual([]);
    expect(nativeGraphReferenceSearch(fixture, 'backdrop')).toHaveLength(4);
    expect(nativeGraphReferenceSearch(fixture, '')).toEqual([]);
  });
});
