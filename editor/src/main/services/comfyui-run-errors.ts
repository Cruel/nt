export class ComfyUiRunError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
    readonly interrupted = false,
  ) {
    super(message);
    this.name = 'ComfyUiRunError';
  }
}
