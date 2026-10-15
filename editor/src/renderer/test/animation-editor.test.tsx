import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vite-plus/test';
import { AnimationEditor } from '@/editors/animations/AnimationEditor';
import { useProjectStore } from '@/project/project-store';
import { useCommandStore } from '@/commands/command-store';
import {
  createAuthoringProject,
  isAuthoringProject,
} from '../../shared/project-schema/authoring-project';

beforeEach(() => {
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  const project = createAuthoringProject();
  project.animations.pulse = {
    id: 'pulse',
    label: 'Pulse',
    data: {
      kind: 'animation',
      canvas: { width: 16, height: 16 },
      defaultMotionId: 'idle',
      motions: [
        {
          id: 'idle',
          kind: 'sprite-sequence',
          markers: [{ id: 'middle', timeMs: 50 }],
          frames: [
            { image: { $ref: { collection: 'assets', id: 'a' } }, durationMs: 50 },
            { image: { $ref: { collection: 'assets', id: 'b' } }, durationMs: 100 },
          ],
        },
      ],
    },
  };
  useProjectStore.getState().loadProjectDocument({
    document: project,
    projectPath: '/mock/project',
    projectFilePath: '/mock/project/project.yaml',
  });
});

function spriteMotion(project: ReturnType<typeof createAuthoringProject>) {
  const motion = project.animations.pulse!.data.motions[0]!;
  if (motion.kind !== 'sprite-sequence') throw new Error('Expected sprite motion');
  return motion;
}

it('adds a timed image frame to an empty manual Animation through the command bus', async () => {
  const project = structuredClone(useProjectStore.getState().document);
  if (!isAuthoringProject(project)) throw new Error('Expected Project');
  spriteMotion(project).frames = [];
  project.animations.pulse!.data.motions[0]!.markers = [];
  project.assets.a = {
    id: 'a',
    label: 'A',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/images/a.png' },
      aliases: [],
      imageMetadata: { width: 16, height: 16, hasAlpha: true, orientation: 1 },
    },
  };
  useProjectStore.getState().loadProjectDocument({
    document: project,
    projectPath: '/mock/project',
    projectFilePath: '/mock/project/project.yaml',
  });
  render(
    <AnimationEditor
      tab={{
        id: 'pulse',
        title: 'Pulse',
        editorType: 'animation-detail',
        resource: {
          kind: 'record',
          stableId: 'record:animations:pulse',
          collection: 'animations',
          entityId: 'pulse',
        },
      }}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Add image frame' }));
  const edited = useProjectStore.getState().document;
  if (!isAuthoringProject(edited)) throw new Error('Expected Project');
  expect(spriteMotion(edited).frames).toEqual([
    { image: { $ref: { collection: 'assets', id: 'a' } }, durationMs: 100 },
  ]);
});

it('scrubs, steps and restarts without editing durable Animation content, and edits markers with undo', async () => {
  const user = userEvent.setup();
  render(
    <AnimationEditor
      tab={{
        id: 'pulse',
        title: 'Pulse',
        editorType: 'animation-detail',
        resource: {
          kind: 'record',
          stableId: 'record:animations:pulse',
          collection: 'animations',
          entityId: 'pulse',
        },
      }}
    />,
  );
  const before = JSON.stringify(useProjectStore.getState().document);
  await user.click(screen.getByRole('button', { name: 'Next frame' }));
  expect(screen.getByLabelText('Frame index')).toHaveTextContent('1 / 2');
  fireEvent.change(screen.getByLabelText('Motion time (ms)'), { target: { value: '25' } });
  expect(screen.getByLabelText('Frame index')).toHaveTextContent('0 / 2');
  await user.click(screen.getByRole('button', { name: 'Play' }));
  await user.click(screen.getByRole('button', { name: 'Pause' }));
  await user.click(screen.getByRole('button', { name: 'Restart' }));
  expect(screen.getByLabelText('Frame index')).toHaveTextContent('0 / 2');
  expect(JSON.stringify(useProjectStore.getState().document)).toBe(before);
  await user.click(screen.getByRole('button', { name: 'Add marker' }));
  const document = useProjectStore.getState().document;
  if (!isAuthoringProject(document)) throw new Error('Expected Project');
  expect(document.animations.pulse!.data.motions[0]!.markers).toContainEqual({
    id: 'marker',
    timeMs: 0,
  });
  act(() => {
    useCommandStore.getState().undo();
  });
  expect(JSON.stringify(useProjectStore.getState().document)).toBe(before);
});

it('shows short video capability notices with details in a tooltip, not on sprite-only animations', async () => {
  const tab = {
    id: 'pulse',
    title: 'Pulse',
    editorType: 'animation-detail',
    resource: {
      kind: 'record',
      stableId: 'record:animations:pulse',
      collection: 'animations',
      entityId: 'pulse',
    },
  } as const;
  const spriteOnly = render(<AnimationEditor tab={tab} />);
  expect(screen.queryByText('Hardware decoding may be unavailable')).toBeNull();
  spriteOnly.unmount();

  const project = structuredClone(useProjectStore.getState().document);
  if (!isAuthoringProject(project)) throw new Error('Expected Project');
  project.assets.video = {
    id: 'video',
    label: 'Video',
    data: {
      kind: 'video',
      source: { type: 'project-file', path: 'assets/video/source.mp4' },
      aliases: [],
      imageMetadata: null,
    },
  };
  // The notice applies even while the sprite motion is selected: canvas size is shared.
  project.animations.pulse!.data.motions.push({
    id: 'motion-video',
    kind: 'video',
    video: { $ref: { collection: 'assets', id: 'video' } },
    markers: [],
  });
  expect(
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.yaml',
    }),
  ).toBe(true);
  render(<AnimationEditor tab={tab} />);
  expect(screen.getByText('Hardware decoding may be unavailable')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(/minimum of 128×128/u)).toBeNull();
  const user = userEvent.setup();
  await user.hover(screen.getByRole('button', { name: 'Video playback details' }));
  expect(await screen.findByText(/below the tested NVIDIA minimum of 128×128/u)).toBeVisible();

  fireEvent.change(screen.getByLabelText('Canvas width'), { target: { value: '128' } });
  fireEvent.blur(screen.getByLabelText('Canvas width'));
  fireEvent.change(screen.getByLabelText('Canvas height'), { target: { value: '128' } });
  fireEvent.blur(screen.getByLabelText('Canvas height'));
  await waitFor(() =>
    expect(screen.queryByText('Hardware decoding may be unavailable')).toBeNull(),
  );

  fireEvent.change(screen.getByLabelText('Canvas width'), { target: { value: '129' } });
  fireEvent.blur(screen.getByLabelText('Canvas width'));
  expect(screen.getByText('Hardware decoding may be unavailable')).toBeInTheDocument();
  await user.hover(screen.getByRole('button', { name: 'Video playback details' }));
  expect(await screen.findByText(/odd dimensions unsupported/u)).toBeVisible();

  fireEvent.change(screen.getByLabelText('Canvas width'), { target: { value: '8193' } });
  fireEvent.blur(screen.getByLabelText('Canvas width'));
  expect(screen.getByRole('alert')).toHaveTextContent('Video exceeds native playback limits');
  expect(screen.queryByText('Hardware decoding may be unavailable')).toBeNull();
  await user.hover(screen.getByRole('button', { name: 'Video playback details' }));
  expect(await screen.findByText(/at most 8192 pixels per side/u)).toBeVisible();
});

it('uses motion-relative video scrub, restart, and playback rather than independent source controls', async () => {
  const project = structuredClone(useProjectStore.getState().document);
  if (!isAuthoringProject(project)) throw new Error('Expected Project');
  project.assets.video = {
    id: 'video',
    label: 'Video',
    data: {
      kind: 'video',
      source: { type: 'project-file', path: 'assets/video/source.mp4' },
      aliases: [],
      imageMetadata: null,
    },
  };
  project.animations.pulse!.data.motions = [
    {
      id: 'idle',
      kind: 'video',
      video: { $ref: { collection: 'assets', id: 'video' } },
      sourceRange: { startMs: 1000, endMs: 2000 },
      markers: [],
    },
  ];
  expect(
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.yaml',
      projectSessionId: 'video-session',
    }),
  ).toBe(true);
  vi.mocked(window.noveltea.resolveProjectOriginalAssetUrl).mockResolvedValue({
    ok: true,
    url: 'noveltea-asset://source/video-session/video',
    contentHash: `sha256:${'a'.repeat(64)}`,
    byteSize: 1,
  });
  const { container } = render(
    <AnimationEditor
      tab={{
        id: 'pulse',
        title: 'Pulse',
        editorType: 'animation-detail',
        resource: {
          kind: 'record',
          stableId: 'record:animations:pulse',
          collection: 'animations',
          entityId: 'pulse',
        },
      }}
    />,
  );
  await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
  const video = container.querySelector('video')!;
  fireEvent.loadedMetadata(video);
  expect(video.controls).toBe(false);
  expect(video.currentTime).toBe(1);
  fireEvent.change(screen.getByLabelText('Motion time (ms)'), { target: { value: '250' } });
  expect(video.currentTime).toBe(1.25);
  await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
  expect(video.currentTime).toBe(1);
  expect(screen.getByRole('button', { name: 'Play' })).not.toBeDisabled();
});

it('confirms target FPS at authoring time before committing and preserves rational values', async () => {
  const project = structuredClone(useProjectStore.getState().document);
  if (!isAuthoringProject(project)) throw new Error('Expected Project');
  project.assets.video = {
    id: 'video',
    label: 'Video',
    data: {
      kind: 'video',
      source: { type: 'project-file', path: 'assets/video/source.webm' },
      aliases: [],
      imageMetadata: null,
    },
  };
  project.animations.pulse!.data.motions = [
    {
      id: 'idle',
      kind: 'video',
      video: { $ref: { collection: 'assets', id: 'video' } },
      sourceRange: { startMs: 0, endMs: 1000 },
      markers: [],
    },
  ];
  expect(
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.yaml',
      projectSessionId: 'video-session',
    }),
  ).toBe(true);
  vi.mocked(window.noveltea.probeVideoTimeline).mockResolvedValue({
    sampleTimesMs: Array.from({ length: 10 }, (_, index) => index * 100),
    endpointMs: 1000,
  });
  const user = userEvent.setup();
  render(
    <AnimationEditor
      tab={{
        id: 'pulse',
        title: 'Pulse',
        editorType: 'animation-detail',
        resource: {
          kind: 'record',
          stableId: 'record:animations:pulse',
          collection: 'animations',
          entityId: 'pulse',
        },
      }}
    />,
  );
  const sampling = screen.getByRole('combobox', { name: 'Video frame sampling' });
  await user.click(sampling);
  await user.click(screen.getByRole('option', { name: 'Target FPS' }));
  expect(await screen.findByText('Apply target frame rate?')).toBeInTheDocument();
  expect(window.noveltea.probeVideoTimeline).toHaveBeenCalledWith('video-session', {
    assetId: 'video',
    sourcePath: 'assets/video/source.webm',
    sourceRange: { startMs: 0, endMs: 1000 },
  });
  let document = useProjectStore.getState().document;
  if (!isAuthoringProject(document)) throw new Error('Expected Project');
  expect(document.animations.pulse!.data.motions[0]).not.toHaveProperty('frameSampling');
  await user.click(screen.getByRole('button', { name: 'Apply FPS' }));
  document = useProjectStore.getState().document;
  if (!isAuthoringProject(document)) throw new Error('Expected Project');
  expect(document.animations.pulse!.data.motions[0]).toMatchObject({
    frameSampling: { mode: 'target-fps', fps: { numerator: 30000, denominator: 1001 } },
  });
  // A lower target rate maps each output to a distinct source PTS: no modal.
  fireEvent.change(screen.getByLabelText('FPS denominator'), { target: { value: '6000' } });
  fireEvent.blur(screen.getByLabelText('FPS denominator'));
  await waitFor(() => {
    const saved = useProjectStore.getState().document;
    if (!isAuthoringProject(saved)) throw new Error('Expected Project');
    expect(saved.animations.pulse!.data.motions[0]).toMatchObject({
      frameSampling: { mode: 'target-fps', fps: { numerator: 30000, denominator: 6000 } },
    });
  });
  expect(screen.queryByText('Apply target frame rate?')).toBeNull();
  // Cancel a second change that would duplicate source frames. The last
  // committed rational FPS must remain unchanged.
  fireEvent.change(screen.getByLabelText('FPS denominator'), { target: { value: '1001' } });
  fireEvent.blur(screen.getByLabelText('FPS denominator'));
  expect(await screen.findByText('Apply target frame rate?')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  const afterCancel = useProjectStore.getState().document;
  if (!isAuthoringProject(afterCancel)) throw new Error('Expected Project');
  expect(afterCancel.animations.pulse!.data.motions[0]).toMatchObject({
    frameSampling: { mode: 'target-fps', fps: { numerator: 30000, denominator: 6000 } },
  });
  expect(screen.queryByText('Apply target frame rate?')).toBeNull();
});

it('commits frame timing only after an integer duration is entered', async () => {
  const user = userEvent.setup();
  render(
    <AnimationEditor
      tab={{
        id: 'pulse',
        title: 'Pulse',
        editorType: 'animation-detail',
        resource: {
          kind: 'record',
          stableId: 'record:animations:pulse',
          collection: 'animations',
          entityId: 'pulse',
        },
      }}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Next frame' }));
  const duration = screen.getByLabelText('Frame duration (ms)');
  await user.clear(duration);
  await user.type(duration, '80');
  await user.tab();
  const document = useProjectStore.getState().document;
  if (!isAuthoringProject(document)) throw new Error('Expected Project');
  expect(spriteMotion(document).frames[1]!.durationMs).toBe(80);
  void act(() => useCommandStore.getState().undo());
  const restored = useProjectStore.getState().document;
  if (!isAuthoringProject(restored)) throw new Error('Expected Project');
  expect(spriteMotion(restored).frames[1]!.durationMs).toBe(100);
});
