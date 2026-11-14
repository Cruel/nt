/** Electron emits both window close and before-quit. A single flight must drain
 * the acknowledged working-source projection before either can revoke native
 * authority; failures are an explicit choice, never silently swallowed. */
export function createNativeWorkingSourceExitGuard(
  flush: () => Promise<unknown>,
  confirmCloseWithoutProjection: (error: unknown) => Promise<boolean>,
) {
  let ready = false;
  let inFlight: Promise<void> | null = null;
  return {
    get ready() {
      return ready;
    },
    reset() {
      ready = false;
    },
    request(continueExit: () => void) {
      if (ready) {
        continueExit();
        return;
      }
      if (inFlight) return;
      inFlight = (async () => {
        try {
          await flush();
        } catch (error) {
          if (!(await confirmCloseWithoutProjection(error))) return;
        }
        ready = true;
        continueExit();
      })().finally(() => {
        inFlight = null;
      });
    },
  };
}
