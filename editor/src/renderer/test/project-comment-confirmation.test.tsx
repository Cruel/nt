import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  confirmProjectComments,
  ProjectCommentConfirmationDialog,
} from '../project/project-comment-confirmation';
import { saveProjectContentWithComments } from '../project/save-project-content-with-comments';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('centralized YAML comment confirmation', () => {
  const changed = [
    {
      file: 'records/variables/score.yaml',
      path: '/data/value',
      comment: ' why score matters',
      kind: 'changed' as const,
    },
    {
      file: 'records/variables/score.yaml',
      path: '/data/nullable',
      comment: ' nullable for scripts',
      kind: 'changed' as const,
    },
  ];

  it('groups affected comments with Keep, Remove and Cancel decisions', async () => {
    render(<ProjectCommentConfirmationDialog />);
    let first!: Promise<string>;
    await act(async () => {
      first = confirmProjectComments(changed);
    });
    expect(screen.getByText('why score matters')).toBeInTheDocument();
    expect(screen.getByText('nullable for scripts')).toBeInTheDocument();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Save and keep comments' })),
    );
    expect(await first).toBe('keep');

    let second!: Promise<string>;
    await act(async () => {
      second = confirmProjectComments(changed);
    });
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Save and remove comments' })),
    );
    expect(await second).toBe('remove');

    let third!: Promise<string>;
    await act(async () => {
      third = confirmProjectComments(changed);
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })));
    expect(await third).toBe('cancel');
  });

  it('offers a single destructive choice for grouped deleted comments', async () => {
    render(<ProjectCommentConfirmationDialog />);
    let decision!: Promise<string>;
    await act(async () => {
      decision = confirmProjectComments(changed.map((impact) => ({ ...impact, kind: 'deleted' })));
    });
    expect(screen.queryByText('Save and keep comments')).not.toBeInTheDocument();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Delete including comments' })),
    );
    expect(await decision).toBe('delete');
  });

  it('does not send a second save on Cancel and forwards exact revision approval on Keep', async () => {
    render(<ProjectCommentConfirmationDialog />);
    const save = vi
      .spyOn(window.noveltea, 'saveProjectContent')
      .mockResolvedValueOnce({
        ok: false,
        success: false,
        commentConfirmationRequired: true,
        commentConfirmationToken: 'a'.repeat(64),
        commentImpacts: changed,
      })
      .mockResolvedValueOnce({ ok: true, success: true });
    const request = {
      saveUnitIds: ['record:variables:score'],
      affectedPaths: ['/variables/score/data/value'],
      baseValueByPath: {},
      localValueByPath: {},
      operationLabel: 'save',
    };
    let result!: Promise<Awaited<ReturnType<typeof saveProjectContentWithComments>>>;
    await act(async () => {
      result = saveProjectContentWithComments('session', request, emptyEditorProjectState());
    });
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Save and keep comments' })),
    );
    expect((await result).response.success).toBe(true);
    expect(save.mock.calls[1]?.[1].commentConfirmation).toEqual({
      token: 'a'.repeat(64),
      decision: 'keep',
    });

    save.mockReset().mockResolvedValueOnce({
      ok: false,
      success: false,
      commentConfirmationRequired: true,
      commentConfirmationToken: 'b'.repeat(64),
      commentImpacts: changed,
    });
    await act(async () => {
      result = saveProjectContentWithComments('session', request, emptyEditorProjectState());
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })));
    expect((await result).cancelled).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
