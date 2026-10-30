import { describe, expect, it } from 'vite-plus/test';
import { renameInteractableInstancePatches } from '@/project/interactable-instance-operations';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultInteractableData,
  defaultInteractableInstanceData,
} from '../../shared/project-schema/authoring-interactables';

describe('Interactable Instance operations', () => {
  it('refuses a rename onto an existing exact identity', () => {
    const project = createAuthoringProject();
    project.interactables.key = { id: 'key', label: 'Key', data: defaultInteractableData('Key') };
    project.interactableInstances.key = defaultInteractableInstanceData('key', 'key');
    project.interactableInstances.other = defaultInteractableInstanceData('other', 'key');

    expect(renameInteractableInstancePatches(project, 'key', 'other')).toEqual([]);
  });
});
