import { describe, expect, it } from 'vite-plus/test';
import { exportProjectPreferenceKey } from '../export/export-local-preferences';
import {
  DEFAULT_EXPORT_PREFERENCES,
  normalizeExportPreferences,
} from '../stores/preferences-store';

const location = {
  projectId: 'feature-lab',
  projectRoot: '/games/feature-lab',
  projectFilePath: '/games/feature-lab/project.yaml',
};

describe('export destinations are local to the user', () => {
  it('uses a durable project identity instead of the current filesystem location', () => {
    expect(exportProjectPreferenceKey(location)).toBe('project-id:feature-lab');
    expect(
      exportProjectPreferenceKey({
        ...location,
        projectRoot: '/moved/feature-lab',
        projectFilePath: '/moved/feature-lab/project.yaml',
      }),
    ).toBe('project-id:feature-lab');
    expect(exportProjectPreferenceKey({ ...location, projectId: 'new-project' })).toBe(
      'project-path:/games/feature-lab/project.yaml',
    );
  });

  it('discards unsupported path-keyed values without performing a compatibility migration', () => {
    const preferences = {
      ...DEFAULT_EXPORT_PREFERENCES,
      selectedProfileIds: {
        '/games/feature-lab/project.yaml': 'windows-release',
        'project-id:feature-lab': 'runtime-package',
      },
      profileOutputDirectories: {
        '/games/feature-lab/project.yaml::runtime-package': '/home/me/exports/game.ntpkg',
        '/games/feature-lab/project.yaml::windows-release': '/home/me/exports/windows',
        'project-id:feature-lab::windows-release': '/tmp/explicit-preference',
      },
      profileTemplateTokens: {
        '/games/feature-lab/project.yaml::windows-release': 'windows/template-7',
      },
      profileSigningProfileIds: {
        '/games/feature-lab/project.yaml::windows-release': 'my-local-cert',
      },
    };
    const normalized = normalizeExportPreferences(preferences);
    expect(normalized.selectedProfileIds).toEqual({
      'project-id:feature-lab': 'runtime-package',
    });
    expect(normalized.profileOutputDirectories).toEqual({
      'project-id:feature-lab::windows-release': '/tmp/explicit-preference',
    });
    expect(normalized.profileTemplateTokens).toEqual({});
    expect(normalized.profileSigningProfileIds).toEqual({});
    expect(normalizeExportPreferences(normalized)).toEqual(normalized);
  });

  it('retains independent current-format selections without importing bare paths', () => {
    const preferences = {
      ...DEFAULT_EXPORT_PREFERENCES,
      profileOutputDirectories: {
        '/another/project.yaml::runtime-package': '/tmp/other.ntpkg',
        'project-id:other-project::runtime-package': '/tmp/canonical.ntpkg',
      },
    };
    expect(normalizeExportPreferences(preferences).profileOutputDirectories).toEqual({
      'project-id:other-project::runtime-package': '/tmp/canonical.ntpkg',
    });
  });
});
