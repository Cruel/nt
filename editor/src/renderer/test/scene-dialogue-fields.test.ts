import { describe, expect, it } from 'vite-plus/test';
import { isStableRecordEdit, mergeStableRecordEdit } from '@/editors/scene-dialogue-fields';

describe('Scene/Dialogue semantic collection field projection', () => {
  it('merges independent edits to different stable IDs without replacing siblings', () => {
    const before = [
      { id: 'intro', label: 'Intro', timeline: { startMs: 0, durationMs: 10 } },
      { id: 'outro', label: 'Outro', timeline: { startMs: 20, durationMs: 10 } },
    ];
    const changedIntro = [{ ...before[0]!, label: 'Opening' }, before[1]!];
    const changedOutro = [before[0]!, { ...before[1]!, label: 'Closing' }];
    expect(isStableRecordEdit(before, changedIntro)).toBe(true);
    expect(mergeStableRecordEdit(before, changedIntro, changedOutro)).toEqual([
      { ...before[0]!, label: 'Opening' },
      { ...before[1]!, label: 'Closing' },
    ]);
  });

  it('resolves a stable-ID edit after a different member was reordered', () => {
    const before = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ];
    const edit = [{ id: 'a', label: 'A changed' }, before[1]!];
    expect(isStableRecordEdit(before, [before[1]!, before[0]!])).toBe(false);
    expect(mergeStableRecordEdit(before, edit, [before[1]!, before[0]!])).toEqual([
      before[1],
      edit[0],
    ]);
  });

  it('rebases a cue insertion onto a different inserted cue by identity', () => {
    const before = [{ id: 'line', type: 'line', cues: [{ id: 'a', kind: 'voice' }] }];
    const after = [
      {
        id: 'line',
        type: 'line',
        cues: [
          { id: 'a', kind: 'voice' },
          { id: 'b', kind: 'gesture' },
        ],
      },
    ];
    const latest = [
      {
        id: 'line',
        type: 'line',
        cues: [
          { id: 'a', kind: 'voice' },
          { id: 'c', kind: 'camera' },
        ],
      },
    ];
    expect(isStableRecordEdit(before, after)).toBe(true);
    expect(mergeStableRecordEdit(before, after, latest)).toEqual([
      {
        id: 'line',
        type: 'line',
        cues: [
          { id: 'a', kind: 'voice' },
          { id: 'c', kind: 'camera' },
          { id: 'b', kind: 'gesture' },
        ],
      },
    ]);
  });

  it('rejects identity/type changes and never retargets a removed member', () => {
    const before = [{ id: 'start', type: 'sequence', label: 'First' }];
    expect(isStableRecordEdit(before, [{ id: 'renamed', type: 'sequence', label: 'First' }])).toBe(
      false,
    );
    expect(isStableRecordEdit(before, [{ id: 'start', type: 'choice', label: 'First' }])).toBe(
      false,
    );
    expect(() => mergeStableRecordEdit(before, [{ ...before[0]!, label: 'Edited' }], [])).toThrow(
      /removed/u,
    );
  });

  it('rejects a concurrent change to an unkeyed nested list', () => {
    const before = [{ id: 'scene', completionDependencies: ['start'] }];
    const after = [{ id: 'scene', completionDependencies: ['middle'] }];
    const newer = [{ id: 'scene', completionDependencies: ['end'] }];
    expect(isStableRecordEdit(before, after)).toBe(true);
    expect(() => mergeStableRecordEdit(before, after, newer)).toThrow(/unkeyed nested/u);
  });
});
