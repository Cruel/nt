import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  emptyEditorProjectState,
  stripEditorProjectState,
} from '../../shared/project-schema/editor-project-state';
import { useCommandStore } from '@/commands/command-store';
import { toJsonValue } from '@/project/json-value';
import { selectProjectDirty, useProjectStore } from '@/project/project-store';
import { getTabDirtyState } from '@/workbench/dirty-state';
import { selectPendingSaveUnitIds, usePendingInputStore } from '@/workbench/pending-input-store';
import {
  buildEditorProjectStateSnapshot,
  reconstructEditorProject,
  setLoadedEditorProjectState,
} from '@/workbench/project-editor-state';
import type { WorkbenchTab } from '@/workbench/workbench-types';

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  setLoadedEditorProjectState(emptyEditorProjectState());
});

describe('project recovery reconstruction', () => {
  it('replays save units by sequence and then stable save-unit ID', () => {
    const project = createAuthoringProject({ id: 'demo', name: 'Saved' });
    const content = toJsonValue(stripEditorProjectState(project));
    const editorState = {
      ...emptyEditorProjectState('a'.repeat(64)),
      recovery: {
        sequence: 2,
        saveUnitsById: {
          'unit:b': {
            sequence: 1,
            patches: [{ op: 'replace' as const, path: '/project/name', value: 'From B' }],
            affectedPaths: ['/project/name'],
            pendingRawInputByPath: {},
            atomicTransactionGroupIds: [],
          },
          'unit:a': {
            sequence: 1,
            patches: [{ op: 'replace' as const, path: '/project/name', value: 'From A' }],
            affectedPaths: ['/project/name'],
            pendingRawInputByPath: {},
            atomicTransactionGroupIds: [],
          },
        },
      },
    };

    const reconstructed = reconstructEditorProject(content, content, editorState, []);

    expect((reconstructed.workingDocument as { project: { name: string } }).project.name).toBe(
      'From B',
    );
    expect((reconstructed.savedDocument as { project: { name: string } }).project.name).toBe(
      'Saved',
    );
    expect(reconstructed.diagnostics).toEqual([]);
  });

  it('restores recovered content as dirty against the disk baseline', () => {
    const project = createAuthoringProject({ id: 'demo', name: 'Saved' });
    const content = toJsonValue(stripEditorProjectState(project));
    const editorState = {
      ...emptyEditorProjectState('b'.repeat(64)),
      recovery: {
        sequence: 1,
        saveUnitsById: {
          'project:settings': {
            sequence: 1,
            patches: [
              { op: 'replace' as const, path: '/project/name', value: 'Recovered and dirty' },
            ],
            affectedPaths: ['/project/name'],
            pendingRawInputByPath: {
              '/settings/display/aspectRatio/width': {
                value: '',
                diagnosticCode: 'authoring.schema.too_small',
              },
            },
            atomicTransactionGroupIds: ['atomic:settings'],
          },
        },
      },
    };
    const reconstructed = reconstructEditorProject(content, content, editorState, []);

    useProjectStore.getState().loadProjectDocument({
      document: reconstructed.workingDocument,
      savedDocument: reconstructed.savedDocument,
      projectPath: '/project',
      projectFilePath: '/project/project.json',
    });

    expect(selectProjectDirty(useProjectStore.getState())).toBe(true);
    expect(
      (useProjectStore.getState().document as { project: { name: string } }).project.name,
    ).toBe('Recovered and dirty');
    const settingsTab: WorkbenchTab = {
      id: 'tab:project-settings',
      title: 'Project Settings',
      editorType: 'project-settings',
      resource: { kind: 'project', stableId: 'project:settings' },
    };
    expect(
      getTabDirtyState(
        settingsTab,
        useProjectStore.getState().document,
        useProjectStore.getState().savedDocument,
        {},
      ),
    ).toMatchObject({
      dirty: true,
      persistentDirty: true,
      saveUnitId: 'project:settings',
    });
  });

  it('hydrates pending-only field input and marks the owning settings save unit dirty', () => {
    const project = createAuthoringProject({ id: 'demo', name: 'Saved' });
    const content = toJsonValue(stripEditorProjectState(project));
    const editorState = {
      ...emptyEditorProjectState('b'.repeat(64)),
      recovery: {
        sequence: 1,
        saveUnitsById: {
          'project:settings': {
            sequence: 1,
            patches: [],
            affectedPaths: ['/settings/display/aspectRatio/width'],
            pendingRawInputByPath: {
              '/settings/display/aspectRatio/width': {
                value: '1.',
                diagnosticCode: 'editor.pending-input.number.invalid',
              },
            },
            atomicTransactionGroupIds: [],
          },
        },
      },
    };

    const reconstructed = reconstructEditorProject(content, content, editorState, []);
    useProjectStore.getState().loadProjectDocument({
      document: reconstructed.workingDocument,
      savedDocument: reconstructed.savedDocument,
      projectPath: '/project',
      projectFilePath: '/project/project.json',
    });
    const settingsTab: WorkbenchTab = {
      id: 'tab:project-settings',
      title: 'Project Settings',
      editorType: 'project-settings',
      resource: { kind: 'project', stableId: 'project:settings' },
    };

    expect(
      usePendingInputStore.getState().entriesBySaveUnitId['project:settings']?.[
        '/settings/display/aspectRatio/width'
      ],
    ).toEqual({
      value: '1.',
      diagnosticCode: 'editor.pending-input.number.invalid',
    });
    expect(
      getTabDirtyState(
        settingsTab,
        useProjectStore.getState().document,
        useProjectStore.getState().savedDocument,
        {},
        selectPendingSaveUnitIds(usePendingInputStore.getState()),
      ),
    ).toMatchObject({
      dirty: true,
      persistentDirty: false,
      pendingInputDirty: true,
      saveUnitId: 'project:settings',
    });
  });

  it('isolates an apply failure and continues with later recovery entries', () => {
    const project = createAuthoringProject({ id: 'demo', name: 'Saved' });
    const content = toJsonValue(stripEditorProjectState(project));
    const editorState = {
      ...emptyEditorProjectState('c'.repeat(64)),
      recovery: {
        sequence: 2,
        saveUnitsById: {
          'unit:broken': {
            sequence: 1,
            patches: [{ op: 'replace' as const, path: '/project/missing', value: 'Nope' }],
            affectedPaths: ['/project/missing'],
            pendingRawInputByPath: {},
            atomicTransactionGroupIds: [],
          },
          'unit:valid': {
            sequence: 2,
            patches: [{ op: 'replace' as const, path: '/project/name', value: 'Recovered' }],
            affectedPaths: ['/project/name'],
            pendingRawInputByPath: {},
            atomicTransactionGroupIds: [],
          },
        },
      },
    };

    const reconstructed = reconstructEditorProject(content, content, editorState, []);

    expect((reconstructed.workingDocument as { project: { name: string } }).project.name).toBe(
      'Recovered',
    );
    expect(reconstructed.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'editor.recovery.patch.failed', severity: 'warning' }),
    );
  });

  it('serializes the same dirty command state deterministically', () => {
    const project = createAuthoringProject({ id: 'demo', name: 'Saved' });
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/project',
      projectFilePath: '/project/project.json',
    });
    setLoadedEditorProjectState(emptyEditorProjectState('d'.repeat(64)));
    useCommandStore.getState().executeCommand({
      type: 'project.applyPatch',
      label: 'Rename project',
      payload: [{ op: 'replace', path: '/project/name', value: 'Dirty' }],
      originSaveUnitId: 'project:settings',
      persistencePolicy: 'manual-save',
      atomicTransactionGroupId: 'atomic:settings',
    });

    const first = buildEditorProjectStateSnapshot().recovery;
    const second = buildEditorProjectStateSnapshot().recovery;

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.saveUnitsById['project:settings']).toEqual({
      sequence: 1,
      patches: [{ op: 'replace', path: '/project/name', value: 'Dirty' }],
      affectedPaths: ['/project/name'],
      pendingRawInputByPath: {},
      atomicTransactionGroupIds: ['atomic:settings'],
    });
  });
});
