import { describe, it, expect } from 'vite-plus/test';
import { cn } from '@/lib/utils';

describe('cn', () => {
  it('merges class strings', () => {
    expect(cn('px-4', 'py-2')).toBe('px-4 py-2');
  });

  it('handles conditional classes', () => {
    const conditionalClass = (enabled: boolean) => enabled && 'hidden';
    expect(cn('base', conditionalClass(false), 'visible')).toBe('base visible');
  });

  it('resolves tailwind conflicts', () => {
    expect(cn('px-4', 'px-6')).toBe('px-6');
  });

  it('handles clsx inputs', () => {
    expect(cn(['a', 'b'], { c: true, d: false })).toBe('a b c');
  });
});
