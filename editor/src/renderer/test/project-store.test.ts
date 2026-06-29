import { describe, expect, it } from 'vitest';
import { selectProjectDirty } from '@/project/project-store';

describe('project store selectors', () => {
  it('derives dirty state from history cursor and saved cursor', () => {
    expect(selectProjectDirty({ document: { room: {} }, historyCursor: -1, savedHistoryCursor: -1 })).toBe(false);
    expect(selectProjectDirty({ document: { room: {} }, historyCursor: 0, savedHistoryCursor: -1 })).toBe(true);
    expect(selectProjectDirty({ document: { room: {} }, historyCursor: 0, savedHistoryCursor: 0 })).toBe(false);
    expect(selectProjectDirty({ document: null, historyCursor: 0, savedHistoryCursor: -1 })).toBe(false);
  });
});
