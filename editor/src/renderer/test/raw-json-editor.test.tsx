import { describe, expect, it } from 'vite-plus/test';
import { defaultEditorRegistry } from '@/workbench/default-editors';

describe('raw JSON editor removal', () => {
  it('does not register a raw JSON editor surface', () => {
    expect(defaultEditorRegistry.resolve('raw-json')).toBeNull();
  });
});
