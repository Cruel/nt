import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { emptyEditorChaptersState, emptyEditorExplorerState } from '../../shared/project-schema/editor-project-state';
import { buildProjectExplorerTree, findProjectExplorerPlacementForTab } from '@/workspace/project-explorer-tree';

function project() {
  const next = createAuthoringProject();
  next.characters.zed = { id: 'zed', label: 'Zed', tags: [], data: defaultCharacterData('Zed') };
  next.characters.anna = { id: 'anna', label: 'Anna', tags: [], data: defaultCharacterData('Anna') };
  next.rooms.cafe = { id: 'cafe', label: 'Cafe', tags: [], data: defaultRoomData('Cafe') };
  next.assets.logo = { id: 'logo', label: 'Logo', tags: [], data: { kind: 'image', source: { type: 'project-file', path: 'assets/logo.png' }, aliases: [], extension: '.png' } };
  return next;
}

describe('project explorer tree', () => {
  it('sorts collections and records alphabetically and keeps collective categories as leaves', () => {
    const tree = buildProjectExplorerTree(project(), { explorer: emptyEditorExplorerState(), chapters: emptyEditorChaptersState() });
    expect(tree.map((node) => node.label)).toEqual([...tree.map((node) => node.label)].sort((a, b) => a.localeCompare(b)));
    const assets = tree.find((node) => node.collection === 'assets');
    expect(assets).toMatchObject({ kind: 'collective-collection', expandable: false, count: 1 });
    const characters = tree.find((node) => node.collection === 'characters');
    expect(characters?.children?.map((node) => node.label)).toEqual(['Anna', 'Zed']);
  });

  it('stows hidden categories under a dimmed Hidden node without dropping children', () => {
    const explorer = { ...emptyEditorExplorerState(), hiddenCollectionKeys: ['characters'] };
    const tree = buildProjectExplorerTree(project(), { explorer, chapters: emptyEditorChaptersState() });
    expect(tree.at(-1)).toMatchObject({ id: 'hidden-root', label: 'Hidden', dimmed: true });
    const hiddenCharacters = tree.at(-1)?.children?.find((node) => node.collection === 'characters');
    expect(hiddenCharacters).toMatchObject({ dimmed: true, label: 'Characters' });
    expect(hiddenCharacters?.children?.map((node) => node.label)).toEqual(['Anna', 'Zed']);
  });

  it('finds active-tab placements by exact explorer node id or record fallback', () => {
    const chapters = {
      records: { prologue: { id: 'prologue', label: 'Prologue', color: null } },
      assignments: { 'characters:anna': ['prologue'] },
    };
    const tree = buildProjectExplorerTree(project(), { explorer: emptyEditorExplorerState(), chapters });
    expect(findProjectExplorerPlacementForTab(tree, {
      id: 'tab:anna',
      title: 'Anna',
      editorType: 'character-detail',
      resource: { kind: 'record', stableId: 'characters:anna', collection: 'characters', entityId: 'anna', explorerNodeId: 'record:characters:anna:all' },
    })).toMatchObject({ node: { id: 'record:characters:anna:all' }, ancestorIds: ['collection:characters', 'all:characters'] });
    expect(findProjectExplorerPlacementForTab(tree, {
      id: 'tab:anna',
      title: 'Anna',
      editorType: 'character-detail',
      resource: { kind: 'record', stableId: 'characters:anna', collection: 'characters', entityId: 'anna' },
    })?.node.id).toBe('record:characters:anna:chapter:prologue');
  });

  it('groups non-collective records by chapters, All, and Unassigned', () => {
    const chapters = {
      records: { prologue: { id: 'prologue', label: 'Prologue', color: null } },
      assignments: { 'characters:anna': ['prologue'] },
    };
    const tree = buildProjectExplorerTree(project(), { explorer: emptyEditorExplorerState(), chapters });
    const characters = tree.find((node) => node.collection === 'characters');
    expect(characters?.children?.map((node) => node.label)).toEqual(['Prologue', 'All', 'Unassigned']);
    expect(characters?.children?.find((node) => node.label === 'All')?.children?.map((node) => node.label)).toEqual(['Anna', 'Zed']);
    expect(characters?.children?.find((node) => node.label === 'Unassigned')?.children?.map((node) => node.label)).toEqual(['Zed']);
  });
});
