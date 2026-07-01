import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PackageExportPanel } from '@/export/PackageExportPanel';
import { defaultExportProfile } from '../../shared/project-schema/authoring-export';
import { usePackageExportStore } from '@/export/package-export-store';
import { useWorkspaceStore } from '@/stores/workspace-store';

beforeEach(() => {
  usePackageExportStore.getState().clear();
  useWorkspaceStore.getState().setLastExportResult(null);
  vi.mocked(window.noveltea.previewExportedPackage).mockResolvedValue({
    ok: false,
    success: false,
    diagnostics: [{ severity: 'warning', category: 'preview', path: '/project/out.ntpkg', message: 'Preview from exported package is not wired.' }],
    error: 'Preview from exported package is not wired.',
  });
});

describe('PackageExportPanel', () => {
  it('renders an empty export state', () => {
    render(<PackageExportPanel />);
    expect(screen.getByText('No package export result yet.')).toBeInTheDocument();
  });

  it('renders manifest, diagnostics, assets, shader outputs, and package actions', async () => {
    usePackageExportStore.getState().finish({
      ok: true,
      success: true,
      stage: 'complete',
      profile: defaultExportProfile(),
      outputPath: '/project/out.ntpkg',
      diagnostics: [{ severity: 'warning', category: 'asset', path: '/assets/logo', message: 'Skipped optional asset.' }],
      validationDiagnostics: [],
      shaderDiagnostics: [],
      shaderOutputs: [{ shader: 'noise', stage: 'fragment', variant: 'glsl-120', sourcePath: '/project/noise.fs.sc', outputPath: '/project/.noveltea/build/shaders/bgfx/glsl-120/noise.fs.bin', runtimePath: 'project:/shaders/bgfx/glsl-120/noise.fs.bin', cacheKey: 'key', cacheHit: false }],
      fileEntries: [{ assetId: 'logo', source: '/project/assets/images/logo.png', packagePath: 'textures/logo.png', kind: 'image' }],
      manifestPreview: { projectName: 'Demo', projectVersion: '1.0', entryCount: 4, assetCount: 1, shaderVariants: ['glsl-120'], requiredShaderBinaryPaths: ['shaders/bgfx/glsl-120/noise.fs.bin'] },
      manifest: { format: 'noveltea.runtime-package', entries: [{ path: 'game', size: 10 }, { path: 'textures/logo.png', size: 42 }] },
      byteCount: 128,
      checksums: { game: 'abcd' },
    });

    render(<PackageExportPanel />);

    expect(screen.getByText('exported')).toBeInTheDocument();
    expect(screen.getByText('/project/out.ntpkg')).toBeInTheDocument();
    expect(screen.getByText('Skipped optional asset.')).toBeInTheDocument();
    expect(screen.getAllByText('textures/logo.png').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('game')).toBeInTheDocument();
    expect(screen.getByText('10 bytes')).toBeInTheDocument();
    expect(screen.getByText('project:/shaders/bgfx/glsl-120/noise.fs.bin')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Preview Package'));
    await waitFor(() => expect(window.noveltea.previewExportedPackage).toHaveBeenCalledWith('/project/out.ntpkg'));
    expect(screen.getByText('Preview from exported package is not wired.')).toBeInTheDocument();
  });
});
