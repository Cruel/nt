import { createHash } from 'node:crypto';
import type { AuthoringProject } from '../project-schema/authoring-project';
import { parseAssetData } from '../project-schema/authoring-assets';
import { parseLayoutData } from '../project-schema/authoring-layouts';
import { parseMaterialData } from '../project-schema/authoring-materials';
import { parseScriptModuleData } from '../project-schema/authoring-script-modules';
import { projectSettingsFromProject } from '../project-schema/authoring-project-settings';
import { classifyProjectValidationDiagnostics } from '../project-schema/project-diagnostic-projection';
import type { ProjectValidationDiagnostic } from '../project-schema/project-diagnostic-projection';
import {
  scopedAuthorityRelevantDeltaPaths,
  scopedAuthoritySignature,
  type ScopedReadAuthorityToken,
} from '../scoped-read-authority';
import { assetSourcePaths } from './project-asset-source-paths';
import type { ProjectWorkspaceFileSystem } from './project-workspace-file-system';
import type {
  LoadedProjectWorkspaceSnapshot,
  ProjectWorkspaceOpenResult,
} from './project-workspace-service';
import type {
  NativeResidentProjectPreparation,
  ResidentProjectAuthority,
  ResidentProjectAuthorityObservation,
} from './native-project-preparation-contracts';
import type {
  PinnedPortableResidentProjectInputs,
  PreparedPortableResidentProjectSnapshot,
} from './resident-project-workspace-service';

/**
 * Certification-only, native-authoritative CLI daemon owner. It intentionally does
 * not inherit ProjectWorkspaceService, construct a TS resident session, or parse
 * authored YAML. This is a separate owner from the editor's existing production
 * Workspace until the coordinated cutover in #521.
 */
type Identity = Readonly<{ sessionEpoch: number; generation: number }>;
type PhysicalEntry = ResidentProjectAuthorityObservation['manifest']['entries'][number];
type TextSource = Readonly<{ text: string; contentHash: `sha256:${string}` }>;
type Portable = Readonly<{
  identity: Identity;
  snapshot: LoadedProjectWorkspaceSnapshot;
  diagnostics: Extract<ProjectWorkspaceOpenResult, { ok: true }>['diagnostics'];
  physicalAuthority: readonly PhysicalEntry[];
  externalAssets: readonly PhysicalEntry[];
  projectTextSources: Readonly<Record<string, TextSource>>;
  nativePreparation: NativeResidentProjectPreparation;
}>;
type Entry = {
  root: string;
  opened: Extract<ProjectWorkspaceOpenResult, { ok: true }>;
  identity: Identity;
  assetPaths: readonly string[];
  lastUsed: number;
  pinned: boolean;
  pinnedInputs: PinnedPortableResidentProjectInputs | null;
  portable: PreparedPortableResidentProjectSnapshot | null;
};

export class NativeResidentProjectAdmissionError extends Error {
  constructor(readonly diagnostics: readonly ProjectValidationDiagnostic[]) {
    super(
      diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message ??
        'Native Project admission failed.',
    );
  }
}

const scopes = [
  { root: 'i18n', extensions: ['.yaml', '.json'], excludedPrefixes: [] },
  {
    root: 'records',
    extensions: ['.yaml', '.json', '.lua', '.rcss', '.rml'],
    excludedPrefixes: [],
  },
  { root: 'scripts', extensions: ['.lua'], excludedPrefixes: [] },
  { root: 'shaders', extensions: ['.sc', '.sh', '.inc', '.glsl', '.h'], excludedPrefixes: [] },
] as const;
let nextEpoch = 1;
const digest = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const validHash = (hash: unknown): hash is `sha256:${string}` =>
  typeof hash === 'string' && /^sha256:[0-9a-f]{64}$/u.test(hash);
const safePath = (name: string): boolean =>
  !!name &&
  !name.includes('\\') &&
  !name.startsWith('/') &&
  name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
const authored = (name: string): boolean =>
  name === 'project.yaml' ||
  name === 'editor.yaml' ||
  name === 'traits.yaml' ||
  /^records\/.+\.(?:yaml|lua|rml|rcss)$/u.test(name) ||
  /^scripts\/.+\.lua$/u.test(name) ||
  /^i18n\/.+\.yaml$/u.test(name);
const semanticChanges = (observation: ResidentProjectAuthorityObservation): boolean =>
  [...observation.delta.added, ...observation.delta.changed, ...observation.delta.removed].some(
    authored,
  );

function textPaths(project: AuthoringProject, physical: readonly PhysicalEntry[]): string[] {
  const paths = new Set<string>();
  for (const notice of projectSettingsFromProject(project).distributionNotices)
    paths.add(notice.path);
  for (const record of Object.values(project.assets))
    for (const attachment of parseAssetData(record.data)?.attachments ?? [])
      if (attachment.purpose === 'distribution-notice') paths.add(attachment.path);
  for (const record of Object.values(project.scripts)) {
    const source = parseScriptModuleData(record.data)?.source;
    if (source?.kind === 'project-file') paths.add(source.path);
  }
  for (const record of Object.values(project.layouts))
    for (const source of parseLayoutData(record.data)?.dependencies.scripts ?? [])
      paths.add(source);
  for (const record of Object.values(project.materials)) {
    const shader = parseMaterialData(record.data)?.shader;
    for (const source of [shader?.vertex, shader?.fragment, shader?.varying])
      if (source?.kind === 'project') paths.add(source.path);
  }
  for (const item of physical)
    if (
      /^scripts\/.+\.lua$/u.test(item.path) ||
      /^records\/layouts\/[^/]+\/layout\.(?:rml|rcss|lua)$/u.test(item.path) ||
      item.path.startsWith('shaders/')
    )
      paths.add(item.path);
  return [...paths].sort();
}

export class NativeResidentProjectOwner {
  private readonly entries = new Map<string, Entry>();
  private readonly epoch: number;

  constructor(
    private readonly files: ProjectWorkspaceFileSystem,
    private readonly authority: ResidentProjectAuthority,
    epoch?: number,
  ) {
    if (!authority.prepareNativeProject || !authority.proveNativeProject)
      throw new Error('Native CLI owner requires native admission and source-generation proof.');
    this.epoch = epoch ?? nextEpoch++;
  }

  private async canonical(root: string): Promise<string> {
    return this.files.resolvePath(await this.files.realpath(this.files.resolvePath(root)));
  }

  private async observe(root: string, assets: readonly string[]) {
    // ProjectAuthorityManager::observe normalizes an omitted path/scope list
    // to the EMPTY configuration, not a request to reuse its previous one.
    // Passing the identical complete configuration preserves the manifest;
    // alternating full/empty config causes false observer deltas on cold reads.
    return this.authority.observe({
      projectRoot: root,
      authoritativePaths: ['project.yaml', 'editor.yaml', 'traits.yaml', ...assets],
      discoveryScopes: scopes,
      includeManifestEntries: true,
    });
  }

  residentSessionCount(): number {
    return this.entries.size;
  }
  residentGenerationIdentities() {
    return [...this.entries.values()].map((entry) => ({
      projectRoot: entry.root,
      identity: entry.identity,
    }));
  }

  async open(projectRoot: string): Promise<ProjectWorkspaceOpenResult> {
    const root = await this.canonical(projectRoot);
    const previous = this.entries.get(root);
    if (previous?.pinned) return previous.opened;
    if (previous) {
      const proof = await this.observe(root, previous.assetPaths);
      if (
        proof.unchanged &&
        !semanticChanges(proof) &&
        !(await this.authority.proveNativeProject!(root, previous.opened.snapshot.sourceRevision))
      ) {
        // A restarted native Project service must re-admit, not reuse stale TS-side state.
      } else if (proof.unchanged && !semanticChanges(proof)) {
        previous.lastUsed = Date.now();
        return previous.opened;
      }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      let native: NativeResidentProjectPreparation;
      try {
        native = await this.authority.prepareNativeProject!(root);
      } catch (error) {
        if (error instanceof Error && 'diagnostics' in error && Array.isArray(error.diagnostics))
          return {
            ok: false,
            projectRoot: root,
            manifestPath: this.files.joinPath(root, 'project.yaml'),
            diagnostics: error.diagnostics,
          } as ProjectWorkspaceOpenResult;
        throw error;
      }
      if (
        !validHash(native.sourceGeneration) ||
        !native.project ||
        !native.sourceRevisions ||
        !native.sourceOverlays ||
        !Array.isArray(native.cliDiagnostics)
      )
        throw new Error('Native Project owner returned malformed admission.');
      const paths = Object.keys(native.sourceRevisions)
        .filter((item) => authored(item) && native.sourceRevisions[item] !== 'absent')
        .sort();
      if (!paths.includes('project.yaml'))
        throw new Error('Native admission omitted project.yaml.');
      const fileRevisions: Record<string, { contentHash: `sha256:${string}`; byteSize: number }> =
        {};
      let raced = false;
      for (const name of paths) {
        const revision = native.sourceRevisions[name];
        if (!safePath(name) || !validHash(revision)) {
          raced = true;
          break;
        }
        try {
          const bytes = await this.files.readBytes(this.files.joinPath(root, name));
          if (digest(bytes) !== revision) {
            raced = true;
            break;
          }
          fileRevisions[name] = { contentHash: revision, byteSize: bytes.byteLength };
        } catch {
          raced = true;
          break;
        }
      }
      if (raced || !(await this.authority.proveNativeProject!(root, native.sourceGeneration)))
        continue;
      const assets = assetSourcePaths(native.project);
      const observed = await this.observe(root, assets);
      if (!observed.unchanged || semanticChanges(observed)) continue;
      const identity = {
        sessionEpoch: previous?.identity.sessionEpoch ?? this.epoch,
        generation: (previous?.identity.generation ?? 0) + 1,
      };
      const snapshot = {
        snapshotKind: 'loaded',
        projectRoot: root,
        manifestPath: this.files.joinPath(root, 'project.yaml'),
        project: native.project,
        workspaceRevision: native.sourceGeneration,
        sourceRevision: native.sourceGeneration,
        canonicalSourceFiles: paths,
        fileRevisions,
        saveUnitFileOwnership: {},
        externalSourceDescriptors: {},
        scriptSourcePaths: {},
      } as unknown as LoadedProjectWorkspaceSnapshot;
      const opened = {
        ok: true,
        snapshot,
        diagnostics: classifyProjectValidationDiagnostics(native.cliDiagnostics, {
          producer: 'authoring',
        }),
        editorState: native.project.editor,
        repairs: [],
        contentProject: native.project,
        savedContentProject: native.project,
        sourceContributions: {},
        validationContributions: [],
        validationWork: { executed: 0, reused: 0 },
        sourceWork: {
          authoredFilesReread: paths.length,
          parsedJsonSources: 0,
          reusedJsonSources: 0,
          readTextSources: paths.length,
          reusedTextSources: 0,
          projectedJsonSources: 0,
          wholeProjectSchemaParses: 0,
          fullProjectTraversals: 0,
          fullProjectProjections: 0,
          foregroundSerializations: 0,
          foregroundSerializedBytes: 0,
          localizationCoverageInputsChanged: true,
          localizationCoverageDependencyRevision: native.sourceGeneration as `sha256:${string}`,
        },
      } as Extract<ProjectWorkspaceOpenResult, { ok: true }>;
      this.entries.set(root, {
        root,
        opened,
        identity,
        assetPaths: assets,
        pinned: false,
        pinnedInputs: null,
        portable: null,
        lastUsed: Date.now(),
      });
      return opened;
    }
    throw new Error('Native Project sources changed during resident admission.');
  }

  async verifyReadAuthority(snapshot: LoadedProjectWorkspaceSnapshot): Promise<boolean> {
    const entry = this.entries.get(snapshot.projectRoot);
    if (!entry || entry.opened.snapshot !== snapshot) return false;
    if (entry.pinned) return true;
    const proof = await this.observe(entry.root, entry.assetPaths);
    return (
      proof.unchanged &&
      !semanticChanges(proof) &&
      (await this.authority.proveNativeProject!(entry.root, snapshot.sourceRevision))
    );
  }

  async reconcileAfterOpaqueWrite(root: string): Promise<void> {
    const canonical = await this.canonical(root);
    if (this.entries.has(canonical)) await this.open(canonical);
  }

  async reconcileResidentSessions(): Promise<number> {
    let advanced = 0;
    for (const entry of this.entries.values()) {
      if (entry.pinned) continue;
      const prior = entry.identity.generation;
      await this.open(entry.root);
      if (this.entries.get(entry.root)?.identity.generation !== prior) advanced++;
    }
    return advanced;
  }

  evictIdleSessions(maxIdle: number, now = Date.now()): number {
    if (!Number.isFinite(maxIdle) || maxIdle <= 0) return 0;
    let count = 0;
    for (const entry of this.entries.values()) {
      if (now - entry.lastUsed < maxIdle) continue;
      this.entries.delete(entry.root);
      if (!entry.pinned) {
        this.authority.release(entry.root);
      }
      count++;
    }
    return count;
  }

  async preparePortableSnapshots(): Promise<readonly PreparedPortableResidentProjectSnapshot[]> {
    const result: PreparedPortableResidentProjectSnapshot[] = [];
    for (const entry of this.entries.values()) {
      if (entry.pinned) continue;
      const opened = await this.open(entry.root);
      if (!opened.ok) continue;
      const current = this.entries.get(entry.root)!;
      const snapshot = await this.preparePortableSnapshot(current);
      if (snapshot) result.push(snapshot);
    }
    return result;
  }

  private async preparePortableSnapshot(
    entry: Entry,
  ): Promise<PreparedPortableResidentProjectSnapshot | null> {
    if (entry.portable) return entry.portable;
    const native = await this.authority.prepareNativeProject!(entry.root);
    if (native.sourceGeneration !== entry.opened.snapshot.sourceRevision) return null;
    let physical = await this.observe(entry.root, entry.assetPaths);
    if (!physical.unchanged || semanticChanges(physical)) return null;
    const sources: Record<string, TextSource> = {};
    for (const name of textPaths(native.project, physical.manifest.entries)) {
      if (!safePath(name)) return null;
      const bytes = await this.files
        .readBytes(this.files.joinPath(entry.root, name))
        .catch(() => null);
      if (!bytes) return null;
      sources[name] = {
        text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes),
        contentHash: digest(bytes),
      };
      if (
        native.sourceRevisions[name] &&
        native.sourceRevisions[name] !== sources[name].contentHash
      )
        return null;
    }
    const externalAssets: PhysicalEntry[] = [];
    for (const name of entry.assetPaths) {
      const observed = physical.manifest.entries.find((item) => item.path === name);
      if (!observed) return null;
      const bytes = await this.files
        .readBytes(this.files.joinPath(entry.root, name))
        .catch(() => null);
      if (!bytes || (observed.byteSize !== undefined && observed.byteSize !== bytes.length))
        return null;
      externalAssets.push({ ...observed, contentHash: digest(bytes) });
    }
    physical = await this.observe(entry.root, entry.assetPaths);
    if (
      !physical.unchanged ||
      semanticChanges(physical) ||
      !(await this.authority.proveNativeProject!(entry.root, native.sourceGeneration))
    )
      return null;
    const portable: Portable = {
      identity: entry.identity,
      snapshot: entry.opened.snapshot,
      diagnostics: entry.opened.diagnostics,
      physicalAuthority: physical.manifest.entries,
      externalAssets,
      projectTextSources: sources,
      nativePreparation: native,
    };
    entry.portable = {
      identity: entry.identity,
      projectRoot: entry.root,
      snapshotText: JSON.stringify(portable),
      ownerMetadataText: JSON.stringify({
        canonicalRoot: entry.root,
        nativeAssetSourcePaths: entry.assetPaths,
      }),
    };
    return entry.portable;
  }

  async hydratePortableSnapshot(root: string, text: string): Promise<boolean> {
    const canonical = await this.canonical(root);
    if (this.entries.has(canonical)) return false;
    let portable: Portable;
    try {
      portable = JSON.parse(text) as Portable;
    } catch {
      return false;
    }
    if (
      !portable ||
      !portable.snapshot ||
      portable.snapshot.projectRoot !== canonical ||
      portable.snapshot.snapshotKind !== 'loaded' ||
      portable.snapshot.sourceRevision !== portable.nativePreparation?.sourceGeneration ||
      !validHash(portable.nativePreparation.sourceGeneration) ||
      !Number.isSafeInteger(portable.identity?.generation) ||
      portable.identity.generation < 1 ||
      !Number.isSafeInteger(portable.identity?.sessionEpoch) ||
      portable.identity.sessionEpoch < 1 ||
      !Array.isArray(portable.physicalAuthority) ||
      !Array.isArray(portable.externalAssets) ||
      !portable.projectTextSources ||
      typeof portable.projectTextSources !== 'object' ||
      JSON.stringify(portable.snapshot.project) !==
        JSON.stringify(portable.nativePreparation.project)
    )
      return false;
    const expectedPaths = Object.keys(portable.nativePreparation.sourceRevisions)
      .filter(
        (name) => authored(name) && portable.nativePreparation.sourceRevisions[name] !== 'absent',
      )
      .sort();
    if (JSON.stringify(expectedPaths) !== JSON.stringify(portable.snapshot.canonicalSourceFiles))
      return false;
    const physicalPaths = new Set(portable.physicalAuthority.map((item) => item.path));
    if (
      portable.physicalAuthority.some((item) => !safePath(item.path)) ||
      physicalPaths.size !== portable.physicalAuthority.length
    )
      return false;
    for (const [name, revision] of Object.entries(portable.nativePreparation.sourceRevisions)) {
      if (
        !safePath(name) ||
        (revision !== 'absent' &&
          !validHash(revision) &&
          !/^physical:[0-9]+:-?[0-9]+$/u.test(revision)) ||
        (revision !== 'absent' && !expectedPaths.includes(name) && !physicalPaths.has(name))
      )
        return false;
    }
    if (
      JSON.stringify(Object.keys(portable.snapshot.fileRevisions).sort()) !==
      JSON.stringify(expectedPaths)
    )
      return false;
    for (const name of expectedPaths)
      if (
        portable.snapshot.fileRevisions[name]?.contentHash !==
        portable.nativePreparation.sourceRevisions[name]
      )
        return false;
    for (const [name, source] of Object.entries(portable.projectTextSources)) {
      if (
        !safePath(name) ||
        !validHash(source?.contentHash) ||
        digest(new TextEncoder().encode(source.text)) !== source.contentHash ||
        (portable.nativePreparation.sourceRevisions[name] &&
          portable.nativePreparation.sourceRevisions[name] !== source.contentHash)
      )
        return false;
    }
    if (
      JSON.stringify(Object.keys(portable.projectTextSources).sort()) !==
      JSON.stringify(textPaths(portable.nativePreparation.project, portable.physicalAuthority))
    )
      return false;
    const assets = assetSourcePaths(portable.nativePreparation.project);
    if (
      portable.externalAssets.length !== assets.length ||
      assets.some(
        (name) =>
          !portable.externalAssets.some(
            (asset) => asset.path === name && validHash(asset.contentHash),
          ),
      )
    )
      return false;
    const opened = {
      ok: true,
      snapshot: portable.snapshot,
      diagnostics: portable.diagnostics,
      editorState: portable.nativePreparation.project.editor,
      repairs: [],
      contentProject: portable.nativePreparation.project,
      savedContentProject: portable.nativePreparation.project,
      sourceContributions: {},
      validationContributions: [],
      validationWork: { executed: 0, reused: 0 },
      sourceWork: {
        authoredFilesReread: 0,
        parsedJsonSources: 0,
        reusedJsonSources: 0,
        readTextSources: 0,
        reusedTextSources: 0,
        projectedJsonSources: 0,
        wholeProjectSchemaParses: 0,
        fullProjectTraversals: 0,
        fullProjectProjections: 0,
        foregroundSerializations: 0,
        foregroundSerializedBytes: 0,
        localizationCoverageInputsChanged: false,
        localizationCoverageDependencyRevision: portable.nativePreparation
          .sourceGeneration as `sha256:${string}`,
      },
    } as Extract<ProjectWorkspaceOpenResult, { ok: true }>;
    this.entries.set(canonical, {
      root: canonical,
      opened,
      identity: portable.identity,
      assetPaths: assets,
      lastUsed: Date.now(),
      pinned: true,
      portable: null,
      pinnedInputs: {
        sourceContributions: {},
        physicalAuthority: portable.physicalAuthority,
        externalAssets: portable.externalAssets,
        projectTextSources: portable.projectTextSources,
        nativePreparation: portable.nativePreparation,
      },
    });
    return true;
  }

  async rehydratePortableSnapshot(
    root: string,
    text: string,
    ownerMetadataText: string,
  ): Promise<boolean> {
    let metadata: { canonicalRoot?: string; nativeAssetSourcePaths?: string[] };
    try {
      metadata = JSON.parse(ownerMetadataText);
    } catch {
      return false;
    }
    const canonical = await this.canonical(root);
    if (metadata.canonicalRoot !== canonical || !Array.isArray(metadata.nativeAssetSourcePaths))
      return false;
    if (!(await this.hydratePortableSnapshot(root, text))) return false;
    const entry = this.entries.get(canonical)!;
    if (JSON.stringify(metadata.nativeAssetSourcePaths) !== JSON.stringify(entry.assetPaths)) {
      this.entries.delete(canonical);
      return false;
    }
    entry.pinned = false;
    entry.portable = {
      identity: entry.identity,
      projectRoot: canonical,
      snapshotText: text,
      ownerMetadataText,
    };
    return true;
  }

  async pinnedPortableInputs(root: string): Promise<PinnedPortableResidentProjectInputs | null> {
    const entry = this.entries.get(await this.canonical(root));
    return entry?.pinned ? entry.pinnedInputs : null;
  }

  async captureScopedReadAuthority(
    root: string,
    requiredSemanticPaths: readonly string[],
  ): Promise<ScopedReadAuthorityToken> {
    const canonicalRoot = await this.canonical(root);
    const assets = this.entries.get(canonicalRoot)?.assetPaths ?? [];
    let observation = await this.observe(canonicalRoot, assets);
    const assetSet = new Set(assets);
    // A previous *completed* mutation may be reported as an observer delta
    // when this is the first scoped read after the write. Establish a new
    // stable baseline before native scoped preparation; do not treat the
    // old delta as an edit racing this invocation.
    for (
      let attempt = 0;
      attempt < 4 &&
      scopedAuthorityRelevantDeltaPaths(observation, requiredSemanticPaths, assetSet).length > 0;
      attempt++
    )
      observation = await this.observe(canonicalRoot, assets);
    return {
      canonicalRoot,
      requiredSemanticPaths,
      authoritySignature: scopedAuthoritySignature(observation, requiredSemanticPaths, assetSet),
      relevantDeltaPaths: scopedAuthorityRelevantDeltaPaths(
        observation,
        requiredSemanticPaths,
        assetSet,
      ),
    };
  }

  async verifyScopedReadAuthority(token: ScopedReadAuthorityToken): Promise<boolean> {
    // Deliberately do not settle/rebaseline here. Any new delta since the
    // token was captured is a concurrent edit and must invalidate the read.
    const assets = this.entries.get(token.canonicalRoot)?.assetPaths ?? [];
    const observation = await this.observe(token.canonicalRoot, assets);
    const assetSet = new Set(assets);
    return (
      scopedAuthoritySignature(observation, token.requiredSemanticPaths, assetSet) ===
        token.authoritySignature &&
      scopedAuthorityRelevantDeltaPaths(observation, token.requiredSemanticPaths, assetSet)
        .length === 0
    );
  }
}
