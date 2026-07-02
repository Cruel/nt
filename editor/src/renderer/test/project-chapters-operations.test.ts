import { describe, expect, it } from 'vitest';
import { createInitialCommandBusState, executeCommand, undoCommand } from '@/commands/command-bus';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';

function project() {
  const next = createAuthoringProject();
  next.characters.iris = { id: 'iris', label: 'Iris', tags: [], data: defaultCharacterData('Iris') };
  next.assets.logo = { id: 'logo', label: 'Logo', tags: [], data: { kind: 'image', source: { type: 'project-file', path: 'assets/logo.png' }, aliases: [], extension: '.png' } };
  return next;
}

describe('project chapter operations', () => {
  it('creates chapters and assigns non-collective records', () => {
    let state = createInitialCommandBusState(toJsonValue(project()));
    const created = executeCommand(state, { type: 'project.createChapter', payload: { chapterId: 'prologue', label: 'Prologue', color: '#8b5cf6' } });
    expect(created.ok).toBe(true);
    state = created.state;
    const assigned = executeCommand(state, { type: 'project.assignChapters', payload: { collection: 'characters', entityId: 'iris', chapterIds: ['prologue'] } });
    expect(assigned.ok).toBe(true);
    expect(assigned.state.document).toMatchObject({ editor: { chapters: { records: { prologue: { label: 'Prologue' } }, assignments: { 'characters:iris': ['prologue'] } } } });
    const undone = undoCommand(assigned.state);
    expect((undone.state.document as ReturnType<typeof project>).editor.chapters.assignments['characters:iris']).toBeUndefined();
  });

  it('rejects chapter assignment for collective categories', () => {
    let state = createInitialCommandBusState(toJsonValue(project()));
    state = executeCommand(state, { type: 'project.createChapter', payload: { chapterId: 'pool', label: 'Pool' } }).state;
    expect(executeCommand(state, { type: 'project.assignChapters', payload: { collection: 'assets', entityId: 'logo', chapterIds: ['pool'] } }).ok).toBe(false);
  });

  it('stores hidden categories and explorer options', () => {
    let state = createInitialCommandBusState(toJsonValue(project()));
    state = executeCommand(state, { type: 'project.setHiddenCollections', payload: { hiddenCollectionKeys: ['verbs', 'objects'] } }).state;
    state = executeCommand(state, { type: 'project.setExplorerOptions', payload: { followActiveTab: false, organizeByChapter: false, groupUnassignedItems: true } }).state;
    expect(state.document).toMatchObject({ editor: { explorer: { hiddenCollectionKeys: ['objects', 'verbs'], followActiveTab: false, organizeByChapter: false, groupUnassignedItems: true } } });
  });
});
