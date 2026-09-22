import { describe, expect, it } from 'vite-plus/test';
import { verifyPinnedExternalAssets } from '../../cli/pinned-external-assets';
import type {
  ProjectWorkspaceFileSystem,
  ProjectWorkspacePathMetadata,
} from '../../shared/project-workspace';

function fileSystem(metadata: ProjectWorkspacePathMetadata): ProjectWorkspaceFileSystem {
  return {
    resolvePath: (value) => value,
    joinPath: (...values) => values.join('/'),
    dirname: () => '/',
    relativePath: () => '',
    inspect: async () => 'file',
    readPathMetadata: async () => metadata,
    listDirectory: async () => [],
    readText: async () => '',
    readBytes: async () => new Uint8Array(),
    readFileRevision: async () => ({
      contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      byteSize: metadata.byteSize ?? 0,
    }),
    writeTextAtomic: async () => undefined,
    writeBytesAtomic: async () => undefined,
    movePathAtomic: async () => undefined,
    removeFile: async () => undefined,
    createDirectory: async () => undefined,
    createDirectoryExclusive: async () => true,
    removeDirectory: async () => undefined,
    realpath: async (value) => value,
  };
}

describe('pinned external Asset verification', () => {
  it('accepts the same physical file identity and exact metadata', async () => {
    const diagnostics = await verifyPinnedExternalAssets(
      fileSystem({
        kind: 'file',
        sourceIdentity: 'posix:1:2',
        byteSize: 42,
        mtimeNanoseconds: '1234',
      }),
      '/project',
      [
        {
          path: 'assets/image.png',
          sourceIdentity: 'posix:1:2',
          byteSize: 42,
          mtimeNanoseconds: '1234',
        },
      ],
    );

    expect(diagnostics).toEqual([]);
  });

  it('rejects identity-preserving metadata drift before output publication', async () => {
    const diagnostics = await verifyPinnedExternalAssets(
      fileSystem({
        kind: 'file',
        sourceIdentity: 'posix:1:2',
        byteSize: 42,
        mtimeNanoseconds: '5678',
      }),
      '/project',
      [
        {
          path: 'assets/image.png',
          sourceIdentity: 'posix:1:2',
          byteSize: 42,
          mtimeNanoseconds: '1234',
        },
      ],
    );

    expect(diagnostics).toEqual([expect.objectContaining({ code: 'export.pinned_input_changed' })]);
  });

  it('falls back to the pinned content hash when exact mtime metadata is unavailable', async () => {
    const diagnostics = await verifyPinnedExternalAssets(
      fileSystem({
        kind: 'file',
        sourceIdentity: 'posix:1:2',
        byteSize: 42,
        mtimeNanoseconds: '5678',
      }),
      '/project',
      [
        {
          path: 'assets/image.png',
          sourceIdentity: 'posix:1:2',
          byteSize: 42,
          mtimeNanoseconds: null,
          contentHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      ],
    );

    expect(diagnostics).toEqual([expect.objectContaining({ code: 'export.pinned_input_changed' })]);
  });
});
