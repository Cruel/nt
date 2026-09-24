import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen } from '@testing-library/react';
import { MaterialEditor } from '@/editors/materials/MaterialEditor';
import { useProjectStore } from '@/project/project-store';
import { useProjectSourceStore } from '@/project/project-source-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import type { WorkbenchTab } from '@/workbench/workbench-types';

vi.mock('@/material-preview/MaterialPreview', () => ({
  MaterialPreview: ({ materialId }: { materialId: string }) => <div>{`preview:${materialId}`}</div>,
}));

const previewResourceState = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('@/material-preview/material-preview-provider', () => ({
  useMaterialPreviewResource: () => previewResourceState.value,
}));

function materialTab(id: string): WorkbenchTab {
  return {
    id: `tab:material-detail:materials:${id}`,
    title: id,
    editorType: 'material-detail',
    resource: {
      kind: 'record',
      stableId: `record:materials:${id}`,
      collection: 'materials',
      entityId: id,
    },
  };
}

beforeEach(() => {
  previewResourceState.value = null;
  useProjectStore.getState().clearProject();
  useProjectSourceStore.getState().clear();
  useWorkbenchStore.getState().resetWorkbench();
});

describe('focused Material editor', () => {
  it('shows effective inherited values with provenance and opens built-in shader source read-only', () => {
    const project = createAuthoringProject();
    project.materials.base = {
      id: 'base',
      label: 'Base',
      data: {
        ...defaultMaterialData('Base', 'postprocess-tint'),
        parameters: { u_tint: { value: [0.2, 0.3, 0.4, 1] } },
      },
    };
    project.materials.child = {
      id: 'child',
      label: 'Child',
      data: {
        ...defaultMaterialData('Child'),
        base: { kind: 'material', material: { $ref: { collection: 'materials', id: 'base' } } },
      },
    };
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    render(<MaterialEditor tab={materialTab('child')} />);

    expect(screen.getByText('Tint')).toBeInTheDocument();
    expect(screen.getByText('u_tint · color')).toBeInTheDocument();
    expect(screen.getByText('Base: Base')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Open source' })[0]!);
    expect(
      useWorkbenchStore.getState().tabsById[
        'tab:engine-shader-source:engine:/vs_postprocess_tint.sc:material:child'
      ],
    ).toMatchObject({ editorType: 'engine-shader-source' });
  });

  it('shows the renderer-owned Engine2D draw texture as a read-only Renderer Input with policy controls', () => {
    const project = createAuthoringProject();
    project.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: {
        ...defaultMaterialData('Panel', 'engine-2d'),
        textures: { s_texColor: { address: 'repeat', filter: 'nearest' } },
      },
    };
    project.assets['texture-one'] = {
      id: 'texture-one',
      label: 'Texture One',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/texture-one.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 1,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      },
    };
    project.assets['texture-two'] = {
      id: 'texture-two',
      label: 'Texture Two',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/texture-two.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 1,
        contentHash: `sha256:${'b'.repeat(64)}`,
        imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
      },
    };
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    render(<MaterialEditor tab={materialTab('panel')} />);

    expect(screen.queryByText('Texture One (texture-one)')).not.toBeInTheDocument();
    expect(screen.queryByText('Texture Two (texture-two)')).not.toBeInTheDocument();

    expect(screen.queryByText('No texture')).not.toBeInTheDocument();
    expect(screen.getByText('Renderer Inputs')).toBeInTheDocument();
    expect(screen.getByText('s_texColor')).toBeInTheDocument();
    expect(screen.getByText(/engine\.draw_texture/)).toBeInTheDocument();
    expect(screen.getByText(/stage 0/)).toBeInTheDocument();
    expect(screen.queryByText('Orphaned texture: s_texColor')).not.toBeInTheDocument();
  });

  it('shows the reflected stage for an author-owned custom sampler', () => {
    const project = createAuthoringProject();
    project.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: {
        ...defaultMaterialData('Panel', 'engine-2d'),
        shader: { fragment: { kind: 'project', path: 'shaders/panel.fs.sc' } },
        textures: { s_noise: { source: { uri: 'project:/assets/noise.png' } } },
      },
    };
    previewResourceState.value = {
      derivedInterface: {
        uniforms: {},
        samplers: {
          s_texColor: { type: 'texture2d', stage: 0, binding: null },
          s_noise: { type: 'texture2d', stage: 3, binding: null },
        },
      },
    };
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    render(<MaterialEditor tab={materialTab('panel')} />);

    expect(screen.getByText('s_noise')).toBeInTheDocument();
    expect(screen.getByText(/This Material · stage 3/)).toBeInTheDocument();
  });

  it('keeps engine-bound inputs read-only and exposes orphan cleanup/rebind UI', () => {
    const project = createAuthoringProject();
    project.materials.hotspot = {
      id: 'hotspot',
      label: 'Hotspot',
      data: {
        ...defaultMaterialData('Hotspot', 'hotspot-overlay-alpha'),
        parameters: { legacy_amount: { value: 0.5 } },
        textures: { legacy_mask: { source: { uri: 'project:/assets/images/legacy.png' } } },
      },
    };
    useProjectStore.getState().loadUnsavedProjectDocument(project);

    render(<MaterialEditor tab={materialTab('hotspot')} />);

    expect(screen.getAllByText('Runtime supplied').length).toBeGreaterThan(0);
    expect(screen.getByText('Orphaned parameter: legacy_amount')).toBeInTheDocument();
    expect(screen.getByText('Orphaned texture: legacy_mask')).toBeInTheDocument();
    expect(screen.getAllByText('Rebind…').length).toBeGreaterThanOrEqual(2);
  });
});
