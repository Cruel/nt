import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PackageExportPanel } from '@/export/PackageExportPanel';
import { defaultExportProfile } from '../../shared/project-schema/authoring-export';
import { usePackageExportStore } from '@/export/package-export-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';

beforeEach(() => {
  usePackageExportStore.getState().clear();
  useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });
  useWorkspaceStore.getState().setLastExportResult(null);
  vi.mocked(window.noveltea.previewExportedPackage).mockResolvedValue({
    ok: false,
    success: false,
    diagnostics: [
      {
        severity: 'warning',
        category: 'preview',
        path: '/project/out.ntpkg',
        message: 'Preview from exported package is not wired.',
      },
    ],
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
      diagnostics: [
        {
          severity: 'warning',
          category: 'asset',
          path: '/assets/logo',
          message: 'Skipped optional asset.',
        },
      ],
      validationDiagnostics: [],
      shaderDiagnostics: [],
      shaderOutputs: [
        {
          shader: 'noise',
          stage: 'fragment',
          variant: 'glsl-120',
          sourcePath: '/project/noise.fs.sc',
          outputPath: '/project/.noveltea/build/shaders/bgfx/glsl-120/noise.fs.bin',
          runtimePath: 'project:/shaders/bgfx/glsl-120/noise.fs.bin',
          cacheKey: 'key',
          byteHash: `sha256:${'a'.repeat(64)}`,
          byteSize: 4,
          cacheHit: false,
        },
      ],
      fileEntries: [
        {
          assetId: 'logo',
          source: '/project/assets/images/logo.png',
          packagePath: 'textures/logo.png',
          storage: 'auto',
          kind: 'image',
        },
      ],
      manifestPreview: {
        projectName: 'Demo',
        projectVersion: '1.0',
        entryCount: 4,
        assetCount: 1,
        shaderVariants: ['glsl-120'],
        requiredShaderBinaryPaths: ['shaders/bgfx/glsl-120/noise.fs.bin'],
        display: {
          reference_resolution: { width: 1920, height: 1080 },
          world_raster_policy: 'capped',
          bar_color: '#000000',
        },
        accessibility: {
          ui_scale: { enabled: true, minimum: 0.75, maximum: 1.5 },
          text_scale: { enabled: true, minimum: 0.75, maximum: 1.5 },
        },
        platform: {
          orientation: 'landscape',
          desktop: {
            initialWidth: 1280,
            initialHeight: 720,
            arguments: ['--display-orientation', 'landscape'],
          },
          web: { orientation: 'landscape', query: 'orientation=landscape' },
          android: {
            orientation: 'landscape',
            gradleProperty: 'novelteaOrientation=landscape',
            screenOrientation: 'sensorLandscape',
          },
        },
      },
      manifest: {
        format: 'noveltea.runtime-package',
        entries: [
          { path: 'game', size: 10 },
          { path: 'textures/logo.png', size: 42 },
        ],
      },
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
    await waitFor(() =>
      expect(window.noveltea.previewExportedPackage).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        '/project/out.ntpkg',
      ),
    );
    expect(screen.getByText('Preview from exported package is not wired.')).toBeInTheDocument();
  });
});
