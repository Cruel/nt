import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import { ReferencesPanel } from '@/workbench/ReferencesPanel';
import { useEntityUsagesStore } from '@/project/entity-usages-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';

beforeEach(() => {
  useEntityUsagesStore.getState().clearUsages();
  useWorkbenchStore.getState().resetWorkbench();
});

describe('ReferencesPanel', () => {
  it('shows source references alongside structured search results', () => {
    const target = { collection: 'rooms' as const, id: 'hall' };
    const structuredUsage = {
      sourceCollection: 'scenes' as const,
      sourceId: 'opening',
      path: '/scenes/opening/data/room/$ref',
      target,
      kind: 'explicit-ref' as const,
    };
    const searchResult = {
      document: {
        id: 'record:scenes:opening',
        kind: 'record' as const,
        collection: 'scenes' as const,
        entityId: 'opening',
        label: 'Opening',
        sourcePath: '/scenes/opening',
        fields: [],
        facets: { collection: 'scenes' as const, tags: [] },
        references: [structuredUsage],
        assetAliasUsages: [],
      },
      score: 1,
      matches: [
        {
          fieldKind: 'reference' as const,
          fieldLabel: 'explicit-ref',
          path: structuredUsage.path,
          value: 'rooms/hall',
          terms: ['rooms/hall'],
          score: 1,
          mode: 'reference' as const,
        },
      ],
    };
    const sourceUsage = {
      edgeId: 'source:hall',
      role: 'lua-possible-reference' as const,
      label: 'Lua Possible Reference',
      sourceLabel: 'scripts · bootstrap',
      targetLabel: 'rooms · hall',
      sourcePath: 'project:/scripts/bootstrap.lua',
      sourceUrl: 'project:/scripts/bootstrap.lua',
      sourceReferenceClassification: 'possible-lexical' as const,
      sourceLocation: { line: 4, column: 12, endLine: 4, endColumn: 18 },
      ambiguousGroup: 'project:/scripts/bootstrap.lua:/rooms/hall',
      edge: {
        id: 'source:hall',
        source: { kind: 'record' as const, collection: 'scripts' as const, id: 'bootstrap' },
        target: { kind: 'record' as const, collection: 'rooms' as const, id: 'hall' },
        sourcePath: '/scripts/bootstrap/data/source/source',
        targetPath: '/rooms/hall',
        role: 'lua-possible-reference' as const,
        facets: ['validation' as const],
        targetImpactPaths: [],
        repair: { kind: 'warning-only' as const, reason: 'Lexical Lua candidate.' },
      },
    };

    useEntityUsagesStore
      .getState()
      .setSearchAndSourceResults(target, [searchResult], [sourceUsage]);
    render(<ReferencesPanel />);

    expect(screen.getByText('scenes/opening')).toBeInTheDocument();
    expect(screen.getByText('possible-lexical')).toBeInTheDocument();
    expect(screen.getByText('project:/scripts/bootstrap.lua:4:12')).toBeInTheDocument();
  });
});
