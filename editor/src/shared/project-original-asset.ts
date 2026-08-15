import { PROJECT_TRUST_FAILURE, type ProjectTrustFailureCode } from './project-trust-boundary';

export const PROJECT_ORIGINAL_ASSET_MAX_BYTES = 128 * 1024 * 1024;

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

export type ProjectOriginalAssetBoundaryCode = ProjectTrustFailureCode | 'invalid-request';

export function projectOriginalAssetBoundaryCode(
  code: ProjectOriginalAssetFailureCode,
): ProjectOriginalAssetBoundaryCode {
  switch (code) {
    case 'invalid-request':
      return 'invalid-request';
    case 'stale-or-unknown':
      return PROJECT_TRUST_FAILURE.STALE_PROJECT_SESSION;
    case 'unknown-asset':
    case 'unsupported-kind':
    case 'invalid-metadata':
      return PROJECT_TRUST_FAILURE.UNAUTHORIZED_ASSET;
    case 'invalid-source':
      return PROJECT_TRUST_FAILURE.UNSAFE_PATH;
    case 'symlink-escape':
      return PROJECT_TRUST_FAILURE.SYMLINK_ESCAPE;
    case 'not-regular-file':
      return PROJECT_TRUST_FAILURE.NOT_REGULAR_FILE;
    case 'too-large':
      return PROJECT_TRUST_FAILURE.SOURCE_TOO_LARGE;
    case 'not-found':
    case 'size-mismatch':
    case 'revision-mismatch':
      return PROJECT_TRUST_FAILURE.SOURCE_REVISION_MISMATCH;
  }
}

export type ProjectOriginalAssetUrlResponse =
  | { ok: true; url: string }
  | {
      ok: false;
      code: ProjectOriginalAssetFailureCode;
      boundaryCode: ProjectOriginalAssetBoundaryCode;
    };

export function projectOriginalAssetUrl(projectSessionId: string, assetId: string): string {
  return `noveltea-asset://source/${encodeURIComponent(projectSessionId)}/${encodeURIComponent(assetId)}`;
}
