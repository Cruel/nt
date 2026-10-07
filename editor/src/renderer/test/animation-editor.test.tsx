import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vite-plus/test';
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
    projectFilePath: '/mock/project/project.json',
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
    projectFilePath: '/mock/project/project.json',
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
