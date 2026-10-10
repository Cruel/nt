import { describe, expect, it, vi } from 'vite-plus/test';
import { validateImportedAudioVideo } from '../../main/services/media-import-validation-service';

const tool = { executable: '/private/ffmpeg', bundled: true } as const;

describe('media import validation', () => {
  it.each([
    ['audio', '-frames:a', '0:a:0'],
    ['video', '-frames:v', '0:v:0'],
  ] as const)(
    'selects and decodes one %s frame without re-encoding the file',
    async (kind, frameLimit, stream) => {
      const run = vi.fn(async (_executable: string, _args: readonly string[]) => ({
        stdout:
          '#format: frame checksums\n#stream: 0\n0,          0,          0,     1024, 1024, abcdef\n',
        stderr: '',
      }));
      await validateImportedAudioVideo('/Project/clip with spaces.mkv', kind, { tool, run });
      expect(run).toHaveBeenCalledOnce();
      const [executable, args] = run.mock.calls[0]!;
      expect(executable).toBe('/private/ffmpeg');
      expect(args).toContain('pipe:1');
      expect(args).toContain(frameLimit);
      expect(args).toContain(stream);
      expect(args).toContain('/Project/clip with spaces.mkv');
    },
  );

  it('rejects valid containers that produce no decoded frames', async () => {
    await expect(
      validateImportedAudioVideo('/Project/empty.mp4', 'video', {
        tool,
        run: async () => ({ stdout: '#format: frame checksums\n', stderr: '' }),
      }),
    ).rejects.toThrow(/no decoded video frames/);
  });

  it('surfaces decoder failures as actionable import errors', async () => {
    await expect(
      validateImportedAudioVideo('/Project/corrupt.ogg', 'audio', {
        tool,
        run: async () => {
          throw new Error('Invalid data found when processing input');
        },
      }),
    ).rejects.toThrow(/Cannot import audio: FFmpeg could not decode.*Invalid data/);
  });
});
