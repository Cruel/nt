import { describe, expect, it } from 'vite-plus/test';
import {
  parseJsonPointer,
  resolveProjectDiagnosticTarget,
} from '@/diagnostics/diagnostic-navigation';
import {
  createAuthoringProject,
  type AuthoringProject,
} from '../../shared/project-schema/authoring-project';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

function projectWithRecords(): AuthoringProject {
  const project = createAuthoringProject();
  project.characters.dfs = {
    id: 'dfs',
    label: 'DFS',
    data: {
      profiles: [
        {
          id: 'stage',
          poses: [{ id: 'idle' }, { id: 'wave' }],
        },
      ],
      expressions: [{ id: 'neutral' }],
      appearances: [{ id: 'formal' }],
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
      hotspots: [{ id: 'door-hotspot' }],
    } as never,
  };
  project.interactables.door = {
    id: 'door',
    label: 'Door',
    data: {
      presentation: {
        hotspots: { kind: 'custom', hotspots: [{ id: 'handle' }] },
      },
    } as never,
  };
  project.interactions.inspect = {
    id: 'inspect',
    label: 'Inspect',
    data: { rules: [{ id: 'handle-rule' }] } as never,
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
      steps: [{ id: 'continue-start' }],
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
      resolveProjectDiagnosticTarget(
        project,
        '/characters/dfs/data/profiles/0/poses/1/layers/0/sprite/$ref',
      )?.target?.id,
    ).toBe('character.profile.stage.pose.wave');
    expect(
      resolveProjectDiagnosticTarget(project, '/characters/dfs/data/expressions/0/profiles/0')
        ?.target?.id,
    ).toBe('character.expression.neutral');
    expect(
      resolveProjectDiagnosticTarget(project, '/characters/dfs/data/appearances/0/profiles/0')
        ?.target?.id,
    ).toBe('character.appearance.formal');
    expect(
      resolveProjectDiagnosticTarget(project, '/characters/dfs/data/profiles/9/poses/0')?.target
        ?.id,
    ).toBe('character.profiles');
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
    expect(
      resolveProjectDiagnosticTarget(project, '/rooms/foyer/data/hotspots/0/target/featureId')
        ?.target?.id,
    ).toBe('room.hotspot.door-hotspot');
    expect(
      resolveProjectDiagnosticTarget(
        project,
        '/interactables/door/data/presentation/hotspots/hotspots/0/target/featureId',
      )?.target?.id,
    ).toBe('interactable.hotspot.handle');
    expect(
      resolveProjectDiagnosticTarget(project, '/interactables/door/data/presentation/hotspots/kind')
        ?.target,
    ).toMatchObject({ id: 'interactable.hotspot-mode', focus: true, flash: true });
    expect(
      resolveProjectDiagnosticTarget(project, '/interactables/door/data/presentation/sprite')
        ?.target?.id,
    ).toBe('interactable.sprite');
    expect(
      resolveProjectDiagnosticTarget(project, '/interactables/door/data/presentation/material')
        ?.target?.id,
    ).toBe('interactable.material');
    expect(
      resolveProjectDiagnosticTarget(
        project,
        '/interactions/inspect/data/rules/0/slots/0/selectors/0/subject/feature',
      )?.target?.id,
    ).toBe('interaction.rule.handle-rule');
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
      resolveProjectDiagnosticTarget(project, '/settings/display/referenceResolution/width')?.target
        ?.id,
    ).toBe('projectSettings.field.referenceResolutionWidth');
    expect(
      resolveProjectDiagnosticTarget(project, '/settings/accessibility/textScale/maximum')?.target
        ?.id,
    ).toBe('projectSettings.field.textScaleMaximum');
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

  it('resolves a room-placed Instance Property diagnostic to the exact hidden Property row', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'key-placement',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        order: 0,
        presentation: { label: null, layout: null },
      },
    ];
    room.interactables = [
      {
        id: 'key-entry',
        interactable: { $ref: { registry: 'interactableInstances', id: 'key-instance' } },
        condition: { kind: 'always' },
        placementId: 'key-placement',
        visible: true,
        order: 0,
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.interactables.key = {
      id: 'key',
      label: 'Key',
      data: defaultInteractableData('Key'),
    };
    project.interactableInstances['key-instance'] = defaultInteractableInstanceData(
      'key-instance',
      'key',
      { kind: 'room', room: { $ref: { collection: 'rooms', id: 'foyer' } } },
    );

    expect(
      resolveProjectDiagnosticTarget(project, {
        path: '/interactableInstances/key-instance/localProperties',
        navigation: {
          kind: 'interactable-instance-property',
          instanceId: 'key-instance',
          propertyId: 'quality',
        },
      }),
    ).toMatchObject({
      tab: { editorType: 'room-detail', resource: { stableId: 'record:rooms:foyer' } },
      target: {
        id: 'instance.property.key-instance.quality',
        payload: {
          kind: 'interactable-instance-property',
          instanceId: 'key-instance',
          propertyId: 'quality',
          placementId: 'key-placement',
        },
      },
    });
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
      'test.step.continue-start',
    );
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
