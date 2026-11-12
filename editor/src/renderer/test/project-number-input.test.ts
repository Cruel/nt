import { describe, expect, it } from 'vite-plus/test';
import { parseProjectNumberText } from '@/commands/project-number-input';

describe('Project numeric lexical contract', () => {
  it('keeps incomplete and nonfinite decimal text pending', () => {
    for (const raw of ['', '-', '+', '.', '2.', '1e3', 'Infinity', 'NaN'])
      expect(parseProjectNumberText(raw)).toBeUndefined();
    expect(parseProjectNumberText('1.0')).toBe(1);
    expect(parseProjectNumberText('.25')).toBe(0.25);
    expect(parseProjectNumberText('+2')).toBe(2);
  });

  it('enforces integer safety and inclusive range bounds', () => {
    expect(parseProjectNumberText('1.25', { mode: 'integer' })).toBeUndefined();
    expect(parseProjectNumberText('9007199254740992', { mode: 'integer' })).toBeUndefined();
    expect(parseProjectNumberText('0', { min: 0, max: 1 })).toBe(0);
    expect(parseProjectNumberText('1', { min: 0, max: 1 })).toBe(1);
    expect(parseProjectNumberText('-1', { min: 0 })).toBeUndefined();
    expect(parseProjectNumberText('2', { max: 1 })).toBeUndefined();
  });
});
