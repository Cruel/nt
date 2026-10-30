import type {
  ReferenceIndex,
  ReferenceUsage,
} from '../../shared/project-schema/authoring-references';

/** Revision-pinned native reference evidence for search presentation tests.
 * These tests intentionally do not rediscover semantic references in TypeScript. */
export function admittedSearchReferenceFixture(): ReferenceIndex {
  const usages: ReferenceUsage[] = [
    {
      sourceCollection: 'scenes',
      sourceId: 'opening',
      path: '/scenes/opening/data/room/$ref',
      target: { collection: 'rooms', id: 'classroom' },
      kind: 'explicit-ref',
    },
    {
      sourceCollection: 'scenes',
      sourceId: 'opening',
      path: '/scenes/opening/data/logo/$ref',
      target: { collection: 'assets', id: 'logo' },
      kind: 'explicit-ref',
    },
  ];
  return {
    usages,
    byTarget: new Map([
      ['rooms:classroom', [usages[0]!]],
      ['assets:logo', [usages[1]!]],
    ]),
  };
}
