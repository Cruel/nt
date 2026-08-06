import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';

export class EditorCacheService {
  readonly #events = new EventEmitter();
  readonly #root: string;
  #epoch = 0;
  #clearPromise: Promise<{ ok: boolean; message?: string; cacheEpoch: number }> | null = null;

  constructor(root: string) {
    this.#root = root;
  }

  get root(): string {
    return this.#root;
  }

  get epoch(): number {
    return this.#epoch;
  }

  get isClearing(): boolean {
    return this.#clearPromise !== null;
  }

  onEpochChanged(listener: (cacheEpoch: number) => void): () => void {
    this.#events.on('epoch', listener);
    return () => this.#events.off('epoch', listener);
  }

  clear(
    settlePreviousEpoch: (previousEpoch: number) => Promise<void>,
    resetBookkeeping: () => void,
  ): Promise<{ ok: boolean; message?: string; cacheEpoch: number }> {
    if (this.#clearPromise) return this.#clearPromise;
    const previousEpoch = this.#epoch;
    this.#epoch += 1;
    const cacheEpoch = this.#epoch;
    this.#clearPromise = (async () => {
      let deletionError: unknown;
      try {
        await settlePreviousEpoch(previousEpoch);
        await fs.rm(this.#root, { recursive: true, force: true });
      } catch (error) {
        deletionError = error;
      } finally {
        resetBookkeeping();
        this.#events.emit('epoch', cacheEpoch);
        this.#clearPromise = null;
      }
      return deletionError
        ? {
            ok: false,
            message:
              deletionError instanceof Error
                ? deletionError.message
                : 'Editor cache deletion failed.',
            cacheEpoch,
          }
        : { ok: true, cacheEpoch };
    })();
    return this.#clearPromise;
  }
}
