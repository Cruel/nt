import { describe, expect, it } from 'vitest';

import { publishCompiledArtifact } from '../../shared/compiled-artifact-publication';
import { compileAuthoringProject } from '../../shared/authoring-compiler';
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

  it('does not publish an artifact when compiler diagnostics contain errors', () => {
    const project = minimalGoldenProject();
    project.entrypoint = { kind: 'room', id: 'missing-room' };
    const published = publishCompiledArtifact(project);
    expect(published.ok).toBe(false);
    if (published.ok) return;
    expect(published.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true);
  });
});
