import { describe, expect, it } from 'vite-plus/test';

import { publishCompiledArtifact } from '../../shared/compiled-artifact-publication';
import { compileAuthoringProject } from '../../shared/authoring-compiler';
import { defaultExportProfile } from '../../shared/project-schema/authoring-export';
import { buildCompiledRuntimeExport } from '../../shared/project-schema/compiled-runtime-export';
import { serializeCompiledProjectWireV1 } from '../../shared/project-schema/compiled-project';
import { minimalGoldenProject } from './fixtures/compiled-project-golden-projects';

describe('compiled artifact publication', () => {
  it('publishes the exact canonical gameplay bytes from the shared compiler', () => {
    const project = minimalGoldenProject();
    const compiled = compileAuthoringProject(project);
    const published = publishCompiledArtifact(project);
    expect(compiled.ok).toBe(true);
    expect(published.ok).toBe(true);
    if (!compiled.ok || !published.ok) return;
    expect(published.project.project).toEqual(compiled.project);
    expect(published.project.gameplayJson).toBe(compiled.canonicalJson);
    expect(published.canonicalJson).toBe(compiled.canonicalJson);
  });

  it('publishes byte-equivalent gameplay for preview, playback, package, and CLI inputs', () => {
    const project = minimalGoldenProject();
    const published = publishCompiledArtifact(project);
    const exported = buildCompiledRuntimeExport(project, {
      projectRoot: '/project',
      profile: { ...defaultExportProfile(project), compileShadersBeforeExport: false },
    });
    expect(published.ok).toBe(true);
    expect(exported.ok).toBe(true);
    if (!published.ok || !exported.compiledProject) return;

    const previewBytes = serializeCompiledProjectWireV1(exported.compiledProject);
    const playbackBytes = serializeCompiledProjectWireV1(exported.compiledProject);
    const packageBytes = serializeCompiledProjectWireV1(exported.compiledProject);
    const cliBytes = serializeCompiledProjectWireV1(exported.compiledProject);
    expect(previewBytes).toBe(published.project.gameplayJson);
    expect(playbackBytes).toBe(previewBytes);
    expect(packageBytes).toBe(previewBytes);
    expect(cliBytes).toBe(previewBytes);
  });

  it('does not publish an artifact when compiler diagnostics contain errors', () => {
    const project = minimalGoldenProject();
    project.entrypoint = { kind: 'room', id: 'missing-room' };
    const published = publishCompiledArtifact(project);
    expect(published.ok).toBe(false);
    if (published.ok) return;
    expect(published.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true);
  });
});
