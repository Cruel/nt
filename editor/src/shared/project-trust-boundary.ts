export const PROJECT_TRUST_FAILURE = {
  STALE_PROJECT_SESSION: 'stale-project-session',
  UNAUTHORIZED_ASSET: 'unauthorized-asset',
  UNSAFE_PATH: 'unsafe-path',
  SYMLINK_ESCAPE: 'symlink-escape',
  NOT_REGULAR_FILE: 'not-regular-file',
  SOURCE_REVISION_MISMATCH: 'source-revision-mismatch',
  SOURCE_TOO_LARGE: 'source-too-large',
  REMOTE_UPLOAD_DENIED: 'remote-upload-denied',
} as const;

export type ProjectTrustFailureCode =
  (typeof PROJECT_TRUST_FAILURE)[keyof typeof PROJECT_TRUST_FAILURE];
