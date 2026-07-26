export const PROJECT_TEXT_SOURCE_LIMITS = Object.freeze({
  maxEntries: 256,
  maxSourceBytes: 2 * 1024 * 1024,
  maxAggregateBytes: 16 * 1024 * 1024,
});

export type Sha256Digest = `sha256:${string}`;

export interface ReadProjectTextSourcesRequest {
  projectReadSessionId: string;
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
      message: string;
    };

export interface ReadProjectTextSourcesResponse {
  entries: readonly ProjectTextSourceReadEntry[];
}

export function isSha256Digest(value: string): value is Sha256Digest {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}
