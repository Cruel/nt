import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  ownerLocalPropertyReferencePaths,
  renameOwnerLocalPropertyReferencePatches,
} from '../project/owner-local-property-references';

describe('owner-local Property references', () => {
  it('counts exact-owner structured references and explicit Lua fallbacks only', () => {
    const project = createAuthoringProject();
    project.scenes.references = {
      id: 'references',
      label: 'References',
      data: {
        operations: [
          {
            kind: 'set-property',
            owner: { kind: 'room', room: { $ref: { collection: 'rooms', id: 'foyer' } } },
            property: { key: 'state' },
            value: true,
          },
          {
            kind: 'unset-property',
            owner: { kind: 'room', room: { $ref: { collection: 'rooms', id: 'hall' } } },
            property: { key: 'state' },
          },
        ],
        additionalDependencies: {
          targets: [
            { kind: 'property-value', owner: { kind: 'room', id: 'foyer' }, propertyId: 'state' },
            { kind: 'property-value', owner: { kind: 'room', id: 'hall' }, propertyId: 'state' },
          ],
        },
      } as never,
    };

    expect(
      ownerLocalPropertyReferencePaths(project, { kind: 'room', id: 'foyer' }, 'state'),
    ).toEqual([
      '/scenes/references/data/additionalDependencies/targets/0/propertyId',
      '/scenes/references/data/operations/0/property/key',
    ]);
  });

  it('produces simple exact-owner rename patches', () => {
    const project = createAuthoringProject();
    project.scenes.references = {
      id: 'references',
      label: 'References',
      data: {
        operation: {
          kind: 'set-property',
          owner: {
            kind: 'character',
            character: { $ref: { collection: 'characters', id: 'hero' } },
          },
          property: { key: 'mood' },
          value: 'calm',
        },
      } as never,
    };

    expect(
      renameOwnerLocalPropertyReferencePatches(
        project,
        { kind: 'character', id: 'hero' },
        'mood',
        'temperament',
      ),
    ).toEqual([
      {
        op: 'replace',
        path: '/scenes/references/data/operation/property/key',
        value: 'temperament',
      },
    ]);
  });
});
