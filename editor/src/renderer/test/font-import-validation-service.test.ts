import { describe, expect, it, vi } from 'vite-plus/test';
import { validateImportedFont } from '../../main/services/font-import-validation-service';

describe('native FreeType font import validation', () => {
  it('passes the absolute source path to the native operation', async () => {
    const inspect = vi.fn(async (_path: string) => ({ ok: true, glyphCount: 678 }));
    await expect(
      validateImportedFont('/Project/fonts/body.woff2', '.woff2', inspect),
    ).resolves.toBeUndefined();
    expect(inspect).toHaveBeenCalledWith('/Project/fonts/body.woff2');
  });

  it('rejects fonts with invalid FreeType faces', async () => {
    await expect(
      validateImportedFont('/Project/fonts/broken.ttf', '.ttf', async () => ({
        ok: false,
        error: 'FreeType could not parse the font face.',
      })),
    ).rejects.toThrow(/Cannot import font.*FreeType could not parse/);
  });

  it('turns native tooling failures into actionable import errors', async () => {
    await expect(
      validateImportedFont('/Project/fonts/body.otf', '.otf', async () => {
        throw new Error('Native font inspection is unavailable');
      }),
    ).rejects.toThrow(/Cannot import font.*Native font inspection is unavailable/);
  });
});
