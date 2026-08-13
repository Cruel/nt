export const EDITOR_IPC_FAILURE = {
  UNTRUSTED_SENDER: 'untrusted-sender',
  INVALID_REQUEST: 'invalid-request',
} as const;

export type EditorIpcFailure = (typeof EDITOR_IPC_FAILURE)[keyof typeof EDITOR_IPC_FAILURE];

export class EditorIpcBoundaryError extends Error {
  readonly code: EditorIpcFailure;

  constructor(code: EditorIpcFailure) {
    super(code);
    this.name = 'EditorIpcBoundaryError';
    this.code = code;
  }
}

function serializedBoundaryCode(error: unknown): EditorIpcFailure | null {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : String(error);
  for (const code of Object.values(EDITOR_IPC_FAILURE)) {
    if (
      message === code ||
      message.endsWith(`: Error: ${code}`) ||
      message.endsWith(`: EditorIpcBoundaryError: ${code}`)
    )
      return code;
  }
  return null;
}

export function normalizeEditorIpcBoundaryError(error: unknown): unknown {
  const code = serializedBoundaryCode(error);
  return code ? new EditorIpcBoundaryError(code) : error;
}
