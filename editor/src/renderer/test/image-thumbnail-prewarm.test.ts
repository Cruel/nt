import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { ImageThumbnailPrewarmCoordinator } from '../workspace/image-thumbnail-prewarm';

describe('image thumbnail prewarm coordinator', () => {
  beforeEach(() => {
    vi.mocked(window.noveltea.prewarmImageThumbnails).mockClear();
    vi.mocked(window.noveltea.cancelImageThumbnailPrewarm).mockClear();
  });

  it('schedules only canonical current image revisions and replaces generations on Save As', () => {
    const project = createAuthoringProject();
    project.assets.logo = {
      id: 'logo',
      label: 'Logo',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/logo.png' },
        aliases: [],
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 320, height: 180, hasAlpha: true, orientation: 1 },
      },
    };
    project.assets.hashless = {
      id: 'hashless',
      label: 'Hashless',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/hashless.png' },
        aliases: [],
        imageMetadata: { width: 1, height: 1, hasAlpha: false, orientation: 1 },
      },
    };

    const coordinator = new ImageThumbnailPrewarmCoordinator();
    coordinator.publish(project, '/project/project.json');
    expect(window.noveltea.prewarmImageThumbnails).toHaveBeenCalledTimes(1);
    const first = vi.mocked(window.noveltea.prewarmImageThumbnails).mock.calls[0]![0];
    expect(first.sources).toHaveLength(1);

    coordinator.publish(project, '/project/project.json');
    expect(window.noveltea.prewarmImageThumbnails).toHaveBeenCalledTimes(1);

    project.assets.logo.data.contentHash = `sha256:${'b'.repeat(64)}`;
    coordinator.publish(project, '/project/project.json');
    expect(window.noveltea.prewarmImageThumbnails).toHaveBeenCalledTimes(2);

    coordinator.publish(project, '/copy/project.json');
    expect(window.noveltea.cancelImageThumbnailPrewarm).toHaveBeenCalledWith({
      projectGeneration: first.projectGeneration,
    });
    expect(window.noveltea.prewarmImageThumbnails).toHaveBeenCalledTimes(3);
  });

  it('publishes a 500-image stress manifest without creating browser image objects', () => {
    const project = createAuthoringProject();
    for (let index = 0; index < 500; index += 1) {
      const family = index % 5;
      const [width, height] =
        family === 0
          ? [3840, 2160]
          : family === 1
            ? [1920, 1080]
            : family === 2
              ? [512, 512]
              : family === 3
                ? [4096, 256]
                : [256, 4096];
      project.assets[`stress-${index}`] = {
        id: `stress-${index}`,
        label: `Stress ${index}`,
        data: {
          kind: 'image',
          source: {
            type: 'project-file',
            path: `assets/images/stress-${index}.${index % 10 === 0 ? 'svg' : 'png'}`,
          },
          aliases: [],
          contentHash: `sha256:${index.toString(16).padStart(64, '0')}`,
          imageMetadata: {
            width,
            height,
            hasAlpha: family === 2,
            orientation: 1,
          },
        },
      };
    }
    const imageConstructor = vi.spyOn(globalThis, 'Image');
    const coordinator = new ImageThumbnailPrewarmCoordinator();
    coordinator.publish(project, '/stress/project.json');
    const calls = vi.mocked(window.noveltea.prewarmImageThumbnails).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0].sources).toHaveLength(500);
    expect(imageConstructor).not.toHaveBeenCalled();
    imageConstructor.mockRestore();
  });
});
