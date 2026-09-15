import { describe, it, expect } from 'vite-plus/test';
import { cn } from '@/lib/utils';

describe('cn', () => {
  it('lets later Tailwind utilities override conflicting defaults', () => {
    expect(cn('px-4', 'px-6')).toBe('px-6');
  });
});
