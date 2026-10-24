import { describe, expect, it } from 'vite-plus/test';
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
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { buildProjectSearchIndex } from '../../shared/project-search/project-search-index';
import { searchProjectIndex } from '../../shared/project-search/project-search';

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
      kind: 'blocked',
      reason: expect.stringContaining('structural dependency'),
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
      kind: 'blocked',
      reason: expect.stringContaining('structural dependency'),
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
