import { describe, expect, it } from 'vite-plus/test';
import {
  parseJsonPointer,
  resolveProjectDiagnosticTarget,
} from '@/diagnostics/diagnostic-navigation';
import {
  createAuthoringProject,
  type AuthoringProject,
} from '../../shared/project-schema/authoring-project';

function projectWithRecords(): AuthoringProject {
  const project = createAuthoringProject();
  project.characters.dfs = {
    id: 'dfs',
    label: 'DFS',
    data: {
      poses: [{ id: 'idle' }, { id: 'wave' }],
      expressions: [{ id: 'neutral' }],
    } as never,
  };
  project.layouts.room_1 = { id: 'room_1', label: 'Room Layout', data: {} as never };
  project.rooms.foyer = {
    id: 'foyer',
    label: 'Foyer',
    data: {
      placements: [{ id: 'door' }],
      exits: [{ id: 'north-door' }],
      overlays: [{ id: 'hud' }],
    } as never,
  };
  project.dialogues.intro = {
    id: 'intro',
    label: 'Intro',
    data: {
      blocks: [{ id: 'start', segments: [{ id: 'line-1' }] }],
      edges: [{ id: 'choice-1', fromBlockId: 'start', toBlockId: 'start' }],
    } as never,
  };
  project.scenes.opening = {
    id: 'opening',
    label: 'Opening',
    data: {
      steps: [{ id: 'show-bg' }, { id: 'say-hi' }],
    } as never,
  };
  project.tests.smoke = {
    id: 'smoke',
    label: 'Smoke',
    data: {
      steps: [{ id: 'click-start', assertions: [{ id: 'mode-check' }] }],
    } as never,
  };
  project.assets.logo = { id: 'logo', label: 'Logo', data: {} as never };
  project.materials.tint = { id: 'tint', label: 'Tint', data: {} as never };
  project.shaders.flat = { id: 'flat', label: 'Flat', data: {} as never };
  project.variables.score = { id: 'score', label: 'Score', data: {} as never };
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
    expect(
      resolveProjectDiagnosticTarget(project, '/characters/dfs/data/poses/1/sprite/$ref')?.target
        ?.id,
    ).toBe('character.pose.wave');
    expect(
      resolveProjectDiagnosticTarget(project, '/characters/dfs/data/expressions/0/sprite/$ref')
        ?.target?.id,
    ).toBe('character.expression.neutral');
    expect(
      resolveProjectDiagnosticTarget(project, '/characters/dfs/data/poses/9/sprite/$ref')?.target
        ?.id,
    ).toBe('character.poses');
  });

  it('resolves layouts, rooms, project settings, and entrypoint paths', () => {
    const project = projectWithRecords();

    expect(
      resolveProjectDiagnosticTarget(project, '/layouts/room_1/data/rcss/sourceText')?.target?.id,
    ).toBe('layout.source.rcss');
    expect(
      resolveProjectDiagnosticTarget(project, '/layouts/room_1/data/rml/sourceText')?.target?.id,
    ).toBe('layout.source.rml');
    expect(
      resolveProjectDiagnosticTarget(project, '/rooms/foyer/data/placements/0/interactable/$ref')
        ?.target?.id,
    ).toBe('room.placement.door');
    expect(
      resolveProjectDiagnosticTarget(project, '/rooms/foyer/data/placements/9/interactable/$ref')
        ?.target?.id,
    ).toBe('room.placements');
    expect(
      resolveProjectDiagnosticTarget(project, '/rooms/foyer/data/exits/0/target/$ref')?.target?.id,
    ).toBe('room.exit.north-door');
    expect(
      resolveProjectDiagnosticTarget(project, '/rooms/foyer/data/lifecycle/canEnter')?.target?.id,
    ).toBe('room.lifecycle');
    expect(
      resolveProjectDiagnosticTarget(project, '/rooms/foyer/data/overlays/0/layout/$ref')?.target
        ?.id,
    ).toBe('room.overlays');
    expect(resolveProjectDiagnosticTarget(project, '/project/name')?.target?.id).toBe(
      'projectSettings.field.projectName',
    );
    expect(resolveProjectDiagnosticTarget(project, '/project/version')?.target?.id).toBe(
      'projectSettings.field.projectVersion',
    );
    expect(resolveProjectDiagnosticTarget(project, '/project/version')?.target).toMatchObject({
      focus: true,
      flash: true,
    });
    expect(
      resolveProjectDiagnosticTarget(project, '/settings/startup/initScript')?.target?.id,
    ).toBe('projectSettings.startup');
    expect(
      resolveProjectDiagnosticTarget(project, '/settings/ui/systemLayouts/title/$ref')?.target?.id,
    ).toBe('projectSettings.field.systemLayout.title');
    expect(
      resolveProjectDiagnosticTarget(project, '/settings/text/defaultFont/$ref')?.target?.id,
    ).toBe('projectSettings.field.defaultFont');
    expect(
      resolveProjectDiagnosticTarget(project, '/settings/display/aspectRatio/width')?.target?.id,
    ).toBe('projectSettings.field.aspectRatioWidth');
    expect(resolveProjectDiagnosticTarget(project, '/settings/app/applicationId')?.target?.id).toBe(
      'projectSettings.field.applicationId',
    );
    expect(
      resolveProjectDiagnosticTarget(
        project,
        '/settings/presentation/roomNavigationTransition/durationMs',
      )?.target,
    ).toMatchObject({ id: 'projectSettings.field.transitionDuration', focus: true });
    expect(resolveProjectDiagnosticTarget(project, '/entrypoint')?.target?.id).toBe(
      'projectSettings.field.entrypoint',
    );
  });

  it('resolves coarse targets for common record families and ignores unknown paths', () => {
    const project = projectWithRecords();

    expect(
      resolveProjectDiagnosticTarget(project, '/dialogues/intro/data/blocks/0')?.target?.id,
    ).toBe('dialogue.block.start');
    expect(
      resolveProjectDiagnosticTarget(
        project,
        '/dialogues/intro/data/blocks/0/segments/0/text/source',
      )?.target?.id,
    ).toBe('dialogue.segment.line-1');
    expect(
      resolveProjectDiagnosticTarget(project, '/dialogues/intro/data/edges/0/toBlockId')?.target
        ?.id,
    ).toBe('dialogue.edge.choice-1');
    expect(
      resolveProjectDiagnosticTarget(project, '/dialogues/intro/data/blocks/9')?.target?.id,
    ).toBe('dialogue.summary');
    expect(
      resolveProjectDiagnosticTarget(project, '/scenes/opening/data/steps/1')?.target?.id,
    ).toBe('scene.step.say-hi');
    expect(
      resolveProjectDiagnosticTarget(project, '/scenes/opening/data/steps/9')?.target?.id,
    ).toBe('scene.summary');
    expect(resolveProjectDiagnosticTarget(project, '/tests/smoke/data/steps/0')?.target?.id).toBe(
      'test.step.click-start',
    );
    expect(
      resolveProjectDiagnosticTarget(project, '/tests/smoke/data/steps/0/assertions/0')?.target?.id,
    ).toBe('test.assertion.mode-check');
    expect(resolveProjectDiagnosticTarget(project, '/tests/smoke/data/steps/9')?.target?.id).toBe(
      'test.summary',
    );
    expect(
      resolveProjectDiagnosticTarget(project, '/assets/logo/data/source/path')?.tab.editorType,
    ).toBe('asset-detail');
    expect(resolveProjectDiagnosticTarget(project, '/materials/tint/data')?.tab.editorType).toBe(
      'material-detail',
    );
    expect(resolveProjectDiagnosticTarget(project, '/shaders/flat/data')?.tab.editorType).toBe(
      'shader-detail',
    );
    expect(
      resolveProjectDiagnosticTarget(project, '/variables/score/data/defaultValue'),
    ).toMatchObject({
      tab: { editorType: 'variables', resource: { stableId: 'variables' } },
      target: { id: 'variable.row.score' },
    });
    expect(resolveProjectDiagnosticTarget(project, '/characters/missing/data/preview')).toBeNull();
    expect(resolveProjectDiagnosticTarget(project, 'not/a/pointer')).toBeNull();
  });
});
