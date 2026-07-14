import { describe, expect, it } from 'vitest';
import { defaultExportProfile } from '../../shared/project-schema/authoring-export';
import { buildAuthoringRuntimeExport } from '../../shared/project-schema/authoring-runtime-export';
import { parseAuthoringProject } from '../../shared/project-schema/authoring-project';
import { createPlatformExportAcceptanceFixture, platformExportFixtureExpectations } from '../../shared/project-schema/platform-export-acceptance-fixture';

describe('platform export acceptance fixture', () => {
  it('is one parseable cross-platform input with every required feature class', () => {
    const project = parseAuthoringProject(createPlatformExportAcceptanceFixture());
    expect(Object.values(project.assets).map((record) => record.data.kind)).toEqual(expect.arrayContaining(['image', 'font', 'audio', 'script']));
    expect(Object.keys(project.layouts)).toHaveLength(1);
    expect(Object.keys(project.shaders)).toHaveLength(1);
    expect(Object.keys(project.materials)).toHaveLength(1);
    expect(project.rooms.foyer?.data.exits).toHaveLength(1);
    expect(platformExportFixtureExpectations.blocked).toEqual(expect.arrayContaining(['runtime-rmlui-layout-mount', 'runtime-audio-playback', 'save-reload-acceptance']));
  });
  it('publishes the complete compiled resource and execution contract', () => {
    const project = createPlatformExportAcceptanceFixture();
    const result = buildAuthoringRuntimeExport(project, { projectRoot: '/fixture', profile: { ...defaultExportProfile(project), compileShadersBeforeExport: false } });
    expect(result.runtimeProject).toHaveProperty('resources.layouts');
    expect(result.runtimeProject).toHaveProperty('definitions.scenes');
    expect(result.runtimeProject).toHaveProperty('definitions.rooms');
    expect(platformExportFixtureExpectations.blocked.length).toBeGreaterThan(0);
  });
});
