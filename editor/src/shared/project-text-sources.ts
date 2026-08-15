import { PROJECT_TRUST_FAILURE, type ProjectTrustFailureCode } from './project-trust-boundary';

export const PROJECT_TEXT_SOURCE_LIMITS = Object.freeze({
  maxEntries: 256,
  maxSourceBytes: 2 * 1024 * 1024,
  maxAggregateBytes: 16 * 1024 * 1024,
});

export type Sha256Digest = `sha256:${string}`;

export interface ReadProjectTextSourcesRequest {
  projectSessionId: string;
  entries: readonly {
    readKey: string;
    projectRelativePath: string;
    expectedContentHash: Sha256Digest;
  }[];
}

export type ProjectTextSourceReadEntry =
  | {
      status: 'ready';
      readKey: string;
      projectRelativePath: string;
      contentHash: Sha256Digest;
      text: string;
      hadUtf8Bom: boolean;
    }
  | {
      status: 'unavailable';
      readKey: string;
      projectRelativePath: string;
      expectedContentHash: string | null;
      code: string;
      boundaryCode: ProjectTrustFailureCode;
      message: string;
    };

export interface ReadProjectTextSourcesResponse {
  entries: readonly ProjectTextSourceReadEntry[];
}

export function projectTextSourceBoundaryCode(code: string): ProjectTrustFailureCode {
  switch (code) {
    case 'stale-session':
      return PROJECT_TRUST_FAILURE.STALE_PROJECT_SESSION;
    case 'unsafe-path':
      return PROJECT_TRUST_FAILURE.UNSAFE_PATH;
    case 'symlink-escape':
      return PROJECT_TRUST_FAILURE.SYMLINK_ESCAPE;
    case 'not-file':
      return PROJECT_TRUST_FAILURE.NOT_REGULAR_FILE;
    case 'source-limit':
    case 'aggregate-limit':
    case 'request-limit':
      return PROJECT_TRUST_FAILURE.SOURCE_TOO_LARGE;
    case 'hash-mismatch':
    case 'read-failed':
    case 'invalid-utf8':
      return PROJECT_TRUST_FAILURE.SOURCE_REVISION_MISMATCH;
    case 'invalid-request':
    default:
      return PROJECT_TRUST_FAILURE.INVALID_REQUEST;
  }
}

export function isSha256Digest(value: string): value is Sha256Digest {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}
