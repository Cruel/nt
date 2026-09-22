import type {
  ProjectWorkspacePathMetadata,
  ProjectWorkspacePathMetadataReader,
} from '../src/shared/project-workspace';

export type ScriptcHostInvoke = (operation: string, requestText: string) => string;

export function createScriptcPathMetadataReader(
  invoke: ScriptcHostInvoke,
): ProjectWorkspacePathMetadataReader {
  return async (path: string): Promise<ProjectWorkspacePathMetadata> => {
    const response = JSON.parse(invoke('path-metadata', JSON.stringify({ path }))) as unknown;
    if (!response || typeof response !== 'object')
      throw new Error('Native path metadata returned an invalid response.');
    const record = response as Record<string, unknown>;
    if (record.ok !== true) {
      throw new Error(
        typeof record.error === 'string' ? record.error : 'Native path metadata inspection failed.',
      );
    }
    const kind = record.kind;
    if (kind === 'missing') return { kind };
    if (kind !== 'file' && kind !== 'directory' && kind !== 'symlink' && kind !== 'other')
      throw new Error('Native path metadata returned an invalid file kind.');
    if (
      !Number.isSafeInteger(record.byteSize) ||
      (record.byteSize as number) < 0 ||
      typeof record.mtimeNanoseconds !== 'string' ||
      !/^\d+$/u.test(record.mtimeNanoseconds)
    )
      throw new Error('Native path metadata returned inexact metadata.');
    return {
      kind,
      ...(typeof record.sourceIdentity === 'string'
        ? { sourceIdentity: record.sourceIdentity }
        : {}),
      byteSize: record.byteSize as number,
      mtimeNanoseconds: record.mtimeNanoseconds,
    };
  };
}
