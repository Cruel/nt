import type { AuthoringProject } from '../project-schema/authoring-project';
import type { ProjectSourceDiscoveryScope } from '../project-source-inventory';

// The pinned native Project data crossing the ScriptC host/daemon boundary.
// These declarations deliberately carry no Workspace service implementation.
export type NativeResidentProjectPreparation = Readonly<{
  project: AuthoringProject;
  sourceGeneration: string;
  sourceRevisions: Readonly<Record<string, string>>;
  sourceOverlays: Readonly<Record<string, string>>;
  referencedAssetIds: readonly string[];
  cliDiagnostics: readonly Readonly<{
    code: string;
    path: string;
    message: string;
    severity: 'warning' | 'info' | 'error';
  }>[];
}>;

export type PortableResidentProjectAuthorityEntry = Readonly<{
  path: string;
  sourceIdentity?: string;
  byteSize?: number;
  mtimeNanoseconds?: string | null;
  contentHash?: string | null;
}>;

export type PortableResidentProjectTextSource = Readonly<{
  contentHash: `sha256:${string}`;
  text: string;
}>;

export interface PreparedPortableResidentProjectSnapshot {
  readonly projectRoot: string;
  readonly identity: Readonly<{ sessionEpoch: number; generation: number }>;
  readonly snapshotText: string;
  readonly ownerMetadataText: string;
}

export type PinnedPortableResidentProjectInputs = Readonly<{
  physicalAuthority: readonly PortableResidentProjectAuthorityEntry[];
  externalAssets: readonly PortableResidentProjectAuthorityEntry[];
  projectTextSources: Readonly<Record<string, PortableResidentProjectTextSource>>;
  nativePreparation: NativeResidentProjectPreparation | null;
}>;

export type PinnedNativeResidentProjectInputs = Readonly<{
  externalAssets: readonly PortableResidentProjectAuthorityEntry[];
  projectTextSources: Readonly<Record<string, PortableResidentProjectTextSource>>;
}>;

export interface ResidentProjectAuthorityRequest {
  readonly projectRoot: string;
  readonly authoritativePaths?: readonly string[];
  readonly discoveryScopes?: readonly ProjectSourceDiscoveryScope[];
  readonly includeManifestEntries?: boolean;
}

export interface ResidentProjectAuthorityObservation {
  readonly previousAuthority: 'untracked' | 'proven' | 'dirty' | 'unknown';
  readonly unchanged: boolean;
  readonly fullRescan: boolean;
  readonly watcherPaths: readonly string[];
  readonly delta: Readonly<{
    added: readonly string[];
    changed: readonly string[];
    removed: readonly string[];
  }>;
  readonly manifest: Readonly<{
    canonicalRoot: string;
    entries: readonly PortableResidentProjectAuthorityEntry[];
  }>;
}

/** Native disk observation must establish authority, not trust watcher hints. */
export interface ResidentProjectAuthority {
  observe(request: ResidentProjectAuthorityRequest): Promise<ResidentProjectAuthorityObservation>;
  release(projectRoot: string): void;
  prepareNativeProject?(projectRoot: string): Promise<NativeResidentProjectPreparation>;
  proveNativeProject?(projectRoot: string, sourceGeneration: string): Promise<boolean>;
}
