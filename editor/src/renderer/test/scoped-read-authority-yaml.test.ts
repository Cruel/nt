import { describe, expect, it } from 'vite-plus/test';
import {
  scopedAuthorityRelevantDeltaPaths,
  scopedAuthoritySignature,
  scopedResidentObservationConfiguration,
  type ScopedReadAuthorityObservation,
} from '../../shared/scoped-read-authority';

describe('standalone scoped read authority for YAML Project owners', () => {
  it('observes the YAML manifest and detects an external edit between capture and verification', () => {
    const configuration = scopedResidentObservationConfiguration(false);
    expect(configuration.authoritativePaths).toEqual([
      'project.yaml',
      'editor.yaml',
      'traits.yaml',
    ]);
    expect(configuration.authoritativePaths).not.toContain('project.json');

    const required = ['/export/profiles'];
    const assets = new Set<string>();
    const observe = (byteSize: number, changed: boolean): ScopedReadAuthorityObservation => ({
      delta: { added: [], changed: changed ? ['project.yaml'] : [], removed: [] },
      manifest: {
        entries: configuration.authoritativePaths.map((path) => ({
          path,
          byteSize: path === 'project.yaml' ? byteSize : 40,
          sourceIdentity: `id:${path}`,
          mtimeNanoseconds: path === 'project.yaml' ? String(byteSize) : '1',
        })),
      },
    });
    const captured = observe(100, false);
    const verified = observe(128, true);
    expect(scopedAuthoritySignature(verified, required, assets)).not.toBe(
      scopedAuthoritySignature(captured, required, assets),
    );
    expect(scopedAuthorityRelevantDeltaPaths(verified, required, assets)).toEqual(['project.yaml']);
  });
});
