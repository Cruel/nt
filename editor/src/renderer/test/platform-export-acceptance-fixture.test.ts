import { describe, expect, it } from 'vite-plus/test';
import { defaultExportProfile } from '../../shared/project-schema/authoring-export';
import { prepareRuntimeAssessmentForTest } from './runtime-artifact-test-helpers';
import { parseAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  createPlatformExportAcceptanceFixture,
  platformExportFixtureExpectations,
} from '../../shared/project-schema/platform-export-acceptance-fixture';

describe('platform export acceptance fixture', () => {
  it('is one parseable cross-platform input with every required feature class', async () => {
    const project = parseAuthoringProject(createPlatformExportAcceptanceFixture());
    expect(Object.values(project.assets).map((record) => record.data.kind)).toEqual(
      expect.arrayContaining(['image', 'font', 'audio', 'script']),
    );
    expect(Object.keys(project.layouts)).toHaveLength(1);
    expect(Object.keys(project.shaders)).toHaveLength(1);
    expect(Object.keys(project.materials)).toHaveLength(1);
    expect(project.rooms.foyer?.data.exits).toHaveLength(1);
    expect(platformExportFixtureExpectations.blocked).toEqual(
      expect.arrayContaining([
        'runtime-rmlui-layout-mount',
        'runtime-audio-playback',
        'save-reload-acceptance',
      ]),
    );
  });
  it('publishes the complete compiled resource and execution contract', async () => {
    const project = createPlatformExportAcceptanceFixture();
    const result = await prepareRuntimeAssessmentForTest(project, {
      projectRoot: '/fixture',
      profile: { ...defaultExportProfile(project), compileShadersBeforeExport: false },
    });
    expect(result.compiledProject).toHaveProperty('resources.layouts');
    expect(result.compiledProject).toHaveProperty('definitions.scenes');
    expect(result.compiledProject).toHaveProperty('definitions.rooms');
    expect(platformExportFixtureExpectations.blocked.length).toBeGreaterThan(0);
  });
});
