import { describe, expect, it } from 'vite-plus/test';
import {
  fieldSaveUnitForPath,
  resolveProjectFieldIdentity,
} from '@/commands/project-field-identity';

describe('#607 editor control Save-unit ownership', () => {
  it.each([
    ['/assets/logo/data/sampling', 'record:assets:logo'],
    ['/editor/recordMetadata/assets/logo/tags', 'record:assets:logo'],
    ['/archetypes/base/data/instanceKind', 'record:archetypes:base'],
    ['/archetypes/base/data/base', 'record:archetypes:base'],
    ['/editor/tags/records/hero/color', 'project:tags'],
    ['/editor/chapters/records/intro/label', 'project:chapters'],
    ['/editor/chapters/records/intro/color', 'project:chapters'],
  ])('binds %s only to %s', (path, owner) => {
    expect(fieldSaveUnitForPath(path)).toBe(owner);
    expect(
      resolveProjectFieldIdentity({
        path,
        saveUnitId: owner,
        projectSessionId: 'native-session',
        projectInstanceId: 'project-instance',
      }).saveUnitId,
    ).toBe(owner);
    expect(() =>
      resolveProjectFieldIdentity({
        path,
        saveUnitId: 'project:settings',
        projectSessionId: 'native-session',
        projectInstanceId: 'project-instance',
      }),
    ).toThrow(/does not belong/u);
  });

  it.each([
    '/editor/tags/records/hero/name',
    '/editor/chapters/records/intro/id',
    '/editor/chapters/assignments/rooms:foyer',
    '/editor/tags/records',
    '/editor/chapters/records/intro',
  ])('keeps %s on a deliberate semantic operation', (path) => {
    expect(fieldSaveUnitForPath(path)).toBeNull();
  });
});
