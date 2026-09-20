import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen } from '@testing-library/react';
import { MaterialsLibraryEditor } from '@/editors/materials/MaterialsLibraryEditor';
import { useProjectStore } from '@/project/project-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import type { WorkbenchTab } from '@/workbench/workbench-types';

vi.mock('@/material-preview/MaterialPreview', () => ({
  MaterialPreview: ({ materialId }: { materialId: string }) => (
    <div data-testid={`material-preview:${materialId}`}>{materialId}</div>
  ),
}));

vi.mock('@/wizard/new-entity/NewEntityWizardDialog', () => ({
  NewEntityWizardDialog: ({
    open,
    initialCollection,
  }: {
    open: boolean;
    initialCollection?: string;
  }) => (open ? <div data-testid="new-entity-wizard">{initialCollection}</div> : null),
}));

const tab: WorkbenchTab = {
  id: 'tab:materials',
  title: 'Materials',
  editorType: 'material-library',
  resource: { kind: 'project', stableId: 'materials', collection: 'materials' },
};

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useWorkbenchStore.getState().resetWorkbench();
  usePreferencesStore.getState().resetToDefaults();
  const project = createAuthoringProject();
  project.materials.panel = {
    id: 'panel',
    label: 'Panel',
    description: 'Soft blue panel',
    data: defaultMaterialData('Panel'),
  };
  project.materials.warning = {
    id: 'warning',
    label: 'Warning Glow',
    description: 'Alert treatment',
    data: defaultMaterialData('Warning Glow', 'postprocess-tint'),
  };
  useProjectStore.getState().loadUnsavedProjectDocument(project);
});

describe('Materials library editor', () => {
  it('browses live Material previews and opens a dedicated focused tab', () => {
    render(<MaterialsLibraryEditor tab={tab} />);

    expect(screen.getByTestId('material-preview:panel')).toBeInTheDocument();
    expect(screen.getByTestId('material-preview:warning')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Panel'));
    fireEvent.click(screen.getByText('Warning Glow'));
    expect(
      useWorkbenchStore.getState().tabsById['tab:material-detail:materials:panel'],
    ).toMatchObject({
      editorType: 'material-detail',
      resource: { collection: 'materials', entityId: 'panel' },
    });
    expect(
      useWorkbenchStore.getState().tabsById['tab:material-detail:materials:warning'],
    ).toMatchObject({ editorType: 'material-detail' });
  });

  it('filters Materials and controls live cards with the editor preference', () => {
    render(<MaterialsLibraryEditor tab={tab} />);

    fireEvent.change(screen.getByLabelText('Search Materials'), { target: { value: 'warning' } });
    expect(screen.queryByText('Panel')).not.toBeInTheDocument();
    expect(screen.getByText('Warning Glow')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Live previews' }));
    expect(usePreferencesStore.getState().materialLibraryLivePreviews).toBe(false);
    expect(screen.queryByTestId('material-preview:warning')).not.toBeInTheDocument();
    expect(screen.getByText('Live preview disabled')).toBeInTheDocument();
  });

  it('launches Material creation through the shared new-entity wizard', () => {
    render(<MaterialsLibraryEditor tab={tab} />);
    fireEvent.click(screen.getByRole('button', { name: 'New Material' }));
    expect(screen.getByTestId('new-entity-wizard')).toHaveTextContent('materials');
  });
});
