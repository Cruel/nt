import { describe, expect, it } from 'vitest';
import { parseJsonPointer, resolveProjectDiagnosticTarget } from '@/diagnostics/diagnostic-navigation';
import { createAuthoringProject, type AuthoringProject } from '../../shared/project-schema/authoring-project';

function projectWithRecords(): AuthoringProject {
  const project = createAuthoringProject();
  project.characters.dfs = { id: 'dfs', label: 'DFS', tags: [], data: {} };
  project.layouts.room_1 = { id: 'room_1', label: 'Room Layout', tags: [], data: {} };
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', tags: [], data: {} };
  project.dialogues.intro = { id: 'intro', label: 'Intro', tags: [], data: {} };
  project.scenes.opening = { id: 'opening', label: 'Opening', tags: [], data: {} };
  project.tests.smoke = { id: 'smoke', label: 'Smoke', tags: [], data: {} };
  project.assets.logo = { id: 'logo', label: 'Logo', tags: [], data: {} };
  project.materials.tint = { id: 'tint', label: 'Tint', tags: [], data: {} };
  project.shaders.flat = { id: 'flat', label: 'Flat', tags: [], data: {} };
  project.variables.score = { id: 'score', label: 'Score', tags: [], data: {} };
  return project;
}

describe('diagnostic navigation', () => {
  it('parses JSON pointer escapes', () => {
    expect(parseJsonPointer('/rooms/a~1b/data/~0key')).toEqual(['rooms', 'a/b', 'data', '~key']);
  });

  it('resolves character preview and collection sections', () => {
    const project = projectWithRecords();

    expect(resolveProjectDiagnosticTarget(project, '/characters/dfs/data/preview')).toMatchObject({
      tab: { editorType: 'character-detail', resource: { stableId: 'record:characters:dfs' } },
      target: { id: 'character.preview' },
    });
    expect(resolveProjectDiagnosticTarget(project, '/characters/dfs/data/poses/2/sprite/$ref')?.target?.id).toBe('character.poses');
    expect(resolveProjectDiagnosticTarget(project, '/characters/dfs/data/expressions/0/sprite/$ref')?.target?.id).toBe('character.expressions');
  });

  it('resolves layouts, rooms, project settings, and entrypoint paths', () => {
    const project = projectWithRecords();

    expect(resolveProjectDiagnosticTarget(project, '/layouts/room_1/data/rcss/sourceText')?.target?.id).toBe('layout.source.rcss');
    expect(resolveProjectDiagnosticTarget(project, '/layouts/room_1/data/rml/sourceText')?.target?.id).toBe('layout.source.rml');
    expect(resolveProjectDiagnosticTarget(project, '/rooms/foyer/data/hotspots/0/object/$ref')?.target?.id).toBe('room.hotspots');
    expect(resolveProjectDiagnosticTarget(project, '/settings/ui/systemLayouts/title/$ref')?.target?.id).toBe('projectSettings.runtime');
    expect(resolveProjectDiagnosticTarget(project, '/entrypoint')?.target?.id).toBe('projectSettings.startup');
  });

  it('resolves coarse targets for common record families and ignores unknown paths', () => {
    const project = projectWithRecords();

    expect(resolveProjectDiagnosticTarget(project, '/dialogues/intro/data/blocks/0')?.tab.editorType).toBe('dialogue-detail');
    expect(resolveProjectDiagnosticTarget(project, '/scenes/opening/data/steps/0')?.tab.editorType).toBe('scene-detail');
    expect(resolveProjectDiagnosticTarget(project, '/tests/smoke/data/steps/0')?.tab.editorType).toBe('test-detail');
    expect(resolveProjectDiagnosticTarget(project, '/assets/logo/data/source/path')?.tab.editorType).toBe('asset-detail');
    expect(resolveProjectDiagnosticTarget(project, '/materials/tint/data')?.tab.editorType).toBe('material-detail');
    expect(resolveProjectDiagnosticTarget(project, '/shaders/flat/data')?.tab.editorType).toBe('shader-detail');
    expect(resolveProjectDiagnosticTarget(project, '/variables/score/data/defaultValue')).toBeNull();
    expect(resolveProjectDiagnosticTarget(project, '/characters/missing/data/preview')).toBeNull();
    expect(resolveProjectDiagnosticTarget(project, 'not/a/pointer')).toBeNull();
  });
});
