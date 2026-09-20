import { describe, expect, it } from 'vite-plus/test';
import { characterizePackagedNodePty } from '../../main/services/terminal-package-smoke';

describe('packaged node-pty lifecycle characterization', () => {
  it('spawns a shell, exchanges I/O, resizes, observes exit, and terminates a PTY', async () => {
    await expect(characterizePackagedNodePty()).resolves.toEqual({
      spawn: true,
      io: true,
      resize: true,
      exit: true,
      terminate: true,
    });
  });
});
