export type ProjectOriginalAssetFailureCode =
  | 'invalid-request'
  | 'stale-or-unknown'
  | 'unknown-asset'
  | 'unsupported-kind'
  | 'invalid-source'
  | 'invalid-metadata'
  | 'symlink-escape'
  | 'not-regular-file'
  | 'not-found'
  | 'too-large'
  | 'size-mismatch'
  | 'revision-mismatch';

export type ProjectAssetUrlResponse =
  | { ok: true; url: string }
  | { ok: false; code: ProjectOriginalAssetFailureCode };
