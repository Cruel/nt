import { describe, expect, it } from 'vite-plus/test';
import { assertNoUnprojectedRendererDrafts } from '../project/agent-working-source-draft-guard';

describe('agent working-source draft preflight (#625)', () => {
  it('reports a content-bearing draft instead of exposing an incomplete repair prompt', () => {
    expect(() =>
      assertNoUnprojectedRendererDrafts({
        'some-raw-form': {
          key: 'some-raw-form',
          tabId: 'room',
          dirty: true,
          schema: 'raw-local-editor-form',
          payload: { text: 'unfinished : [' },
        },
      }),
    ).toThrow(/unsaved editor draft.*cannot yet be represented/);
  });

  it('allows only already-acknowledged or content-free local draft presentation', () => {
    expect(() =>
      assertNoUnprojectedRendererDrafts({
        clean: { key: 'clean', tabId: 'room', dirty: false, payload: { text: 'saved' } },
        visual: { key: 'visual', tabId: 'room', dirty: true },
      }),
    ).not.toThrow();
  });
});
