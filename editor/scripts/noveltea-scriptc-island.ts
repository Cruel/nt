import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NovelTeaCliNativeToolService } from '../src/cli/native-tool-service';
import type {
  LocalizationFontCoverageRequest,
  LocalizationFontCoverageResponse,
} from '../src/shared/localization-font-coverage';
import type { NovelTeaCliPlatformToolService } from '../src/cli/platform-tool-service';
import { NOVELTEA_AUTHORING_VALIDATION_SEMANTIC_KEY } from '../src/cli/static-contracts';
import type { ProjectWorkspaceFileSystem } from '../src/shared/project-workspace/project-workspace-file-system';
import {
  scopedResidentObservationConfiguration,
  scopedAuthorityRelevantDeltaPaths,
  scopedAuthoritySignature,
  type ScopedReadAuthorityToken,
} from '../src/shared/scoped-read-authority';
import type { ScriptcHostInvoke } from './noveltea-scriptc-path-metadata';

let residentInvokeHost: ScriptcHostInvoke | null = null;
let residentFileSystem:
  | import('../src/shared/project-workspace/project-workspace-file-system').ProjectWorkspaceFileSystem
  | undefined;
let residentWorkspace:
  | import('../src/shared/project-workspace/resident-project-workspace-service').ResidentProjectWorkspaceService
  | undefined;
const publishedResidentProjectSnapshots = new Map<string, string>();
const invokeResidentHost: ScriptcHostInvoke = (operation, request) => {
  if (!residentInvokeHost) throw new Error('Resident ScriptC host is unavailable.');
  return residentInvokeHost(operation, request);
};

function announceResidentProjectGenerations(): void {
  if (!residentWorkspace || !residentInvokeHost) return;
  for (const resident of residentWorkspace.residentGenerationIdentities())
    invokeResidentHost(
      'daemon-project-generation',
      JSON.stringify({
        sessionEpoch: resident.identity.sessionEpoch,
        generation: resident.identity.generation,
      }),
    );
}

export async function reconcileNovelTeaResidentProjects(): Promise<number> {
  if (!residentWorkspace) return 0;
  const advanced = await residentWorkspace.reconcileResidentSessions();
  announceResidentProjectGenerations();
  return advanced;
}

export async function commitNovelTeaResidentComfyUiAssetPublication(
  requestText: string,
  invokeHost: ScriptcHostInvoke,
): Promise<Readonly<Record<string, unknown>>> {
  if (!residentWorkspace || !residentFileSystem)
    throw new Error('Resident Project owner is unavailable for ComfyUI Asset publication.');
  residentInvokeHost = invokeHost;
  const request = JSON.parse(requestText) as unknown;
  if (request === null || typeof request !== 'object' || Array.isArray(request))
    throw new Error('ComfyUI Asset publication request is malformed.');
  const { publishStagedComfyUiAssets } =
    await import('../src/main/services/comfyui-asset-publication-service');
  const result = await publishStagedComfyUiAssets({
    request:
      request as import('../src/main/services/comfyui-asset-publication-service').ComfyUiStagedAssetPublicationRequest,
    workspace: residentWorkspace,
    fileSystem: residentFileSystem,
  });
  announceResidentProjectGenerations();
  return result;
}

function portableSnapshotChunks(text: string): string[] {
  const chunks: string[] = [];
  const maxCodeUnits = 24 * 1024;
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + maxCodeUnits);
    if (
      end < text.length &&
      end > offset &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff
    )
      end -= 1;
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

export async function prepareNovelTeaResidentProjectSnapshots(): Promise<number> {
  if (!residentWorkspace || !residentInvokeHost) return 0;
  announceResidentProjectGenerations();
  let published = 0;
  for (const prepared of await residentWorkspace.preparePortableSnapshots()) {
    // Snapshot preparation itself may advance an authority-only generation (for example an Asset
    // payload changed without authored JSON changing), so declare again immediately before upload.
    announceResidentProjectGenerations();
    const key = `${String(prepared.identity.sessionEpoch)}:${String(prepared.identity.generation)}`;
    if (publishedResidentProjectSnapshots.get(prepared.projectRoot) === key) continue;
    invokeResidentHost(
      'daemon-project-snapshot-begin',
      JSON.stringify({
        sessionEpoch: prepared.identity.sessionEpoch,
        generation: prepared.identity.generation,
        ownerMetadata: prepared.ownerMetadataText,
      }),
    );
    for (const chunk of portableSnapshotChunks(prepared.snapshotText))
      invokeResidentHost('daemon-project-snapshot-chunk', JSON.stringify({ chunk }));
    invokeResidentHost('daemon-project-snapshot-commit', '');
    publishedResidentProjectSnapshots.set(prepared.projectRoot, key);
    published += 1;
  }
  return published;
}

export function novelTeaResidentProjectSessionCount(): number {
  return residentWorkspace?.residentSessionCount() ?? 0;
}

function residentProjectAuthority(): import('../src/shared/project-workspace/resident-project-workspace-service').ResidentProjectAuthority {
  const stringArray = (value: unknown, field: string): string[] => {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
      throw new Error(`Native Project authority returned malformed ${field}.`);
    return value;
  };
  return {
    ...(process.env.NOVELTEA_CLI_CERTIFICATION === '1' &&
    process.env.NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE === '1'
      ? {
          async prepareNativeProject(projectRoot: string) {
            const result = JSON.parse(
              invokeResidentHost(
                'native-project-commands',
                JSON.stringify({ action: 'shader-preparation', projectRoot }),
              ),
            ) as Record<string, unknown>;
            if (result.ok !== true) {
              const { NativeResidentProjectAdmissionError } =
                await import('../src/shared/project-workspace/resident-project-workspace-service');
              const { classifyProjectValidationDiagnostics } =
                await import('../src/shared/project-schema/project-validation');
              const errors = Array.isArray(result.projectDiagnostics)
                ? result.projectDiagnostics.filter(
                    (
                      item,
                    ): item is {
                      code: string;
                      path: string;
                      message: string;
                      severity: 'error' | 'warning' | 'info';
                    } =>
                      item !== null &&
                      typeof item === 'object' &&
                      typeof item.code === 'string' &&
                      typeof item.path === 'string' &&
                      typeof item.message === 'string' &&
                      ['error', 'warning', 'info'].includes(item.severity),
                  )
                : [];
              // A transport/source-proof failure can contain advisory warnings. Only a
              // genuine native validation error is a semantic Project rejection.
              if (errors.some((diagnostic) => diagnostic.severity === 'error'))
                throw new NativeResidentProjectAdmissionError(
                  classifyProjectValidationDiagnostics(errors, { producer: 'authoring' }),
                );
              throw new Error(
                typeof result.error === 'string'
                  ? result.error
                  : 'Native Project preparation could not admit the resident generation.',
              );
            }
            // Empty collection maps are the required in-memory Project transport structure;
            // admission and normalization of their contents remain native-owned.
            const { authoringCollectionKeys } =
              await import('../src/shared/project-schema/authoring-collections');
            const project = { ...(result.project as Record<string, unknown>) };
            for (const family of authoringCollectionKeys)
              if (!(family in project)) project[family] = {};
            // The native command envelope contains transport bookkeeping (ok, reused owner).
            // Persist only the exact immutable preparation contract into the generation.
            return {
              project,
              sourceGeneration: result.sourceGeneration,
              sourceRevisions: result.sourceRevisions,
              sourceOverlays: result.sourceOverlays,
              referencedAssetIds: result.referencedAssetIds,
              cliDiagnostics: result.cliDiagnostics,
            } as import('../src/shared/project-workspace/resident-project-workspace-service').NativeResidentProjectPreparation;
          },
          async proveNativeProject(projectRoot: string, sourceGeneration: string) {
            const result = JSON.parse(
              invokeResidentHost(
                'native-project-commands',
                JSON.stringify({
                  action: 'source-generation-proof',
                  projectRoot,
                  expectedSourceGeneration: sourceGeneration,
                }),
              ),
            ) as Record<string, unknown>;
            return result.ok === true;
          },
        }
      : {}),
    async observe(request) {
      const value = JSON.parse(
        invokeResidentHost('daemon-project-observe', JSON.stringify(request)),
      ) as Record<string, unknown>;
      const delta = value.delta as Record<string, unknown> | undefined;
      const manifest = value.manifest as Record<string, unknown> | undefined;
      const previousAuthority = value.previousAuthority;
      if (
        !['untracked', 'proven', 'dirty', 'unknown'].includes(String(previousAuthority)) ||
        typeof value.unchanged !== 'boolean' ||
        typeof value.fullRescan !== 'boolean' ||
        !delta ||
        !manifest ||
        typeof manifest.canonicalRoot !== 'string' ||
        !Array.isArray(manifest.entries)
      )
        throw new Error('Native Project authority observation is malformed.');
      return {
        previousAuthority: previousAuthority as 'untracked' | 'proven' | 'dirty' | 'unknown',
        unchanged: value.unchanged,
        fullRescan: value.fullRescan,
        watcherPaths: stringArray(value.watcherPaths, 'watcherPaths'),
        delta: {
          added: stringArray(delta.added, 'delta.added'),
          changed: stringArray(delta.changed, 'delta.changed'),
          removed: stringArray(delta.removed, 'delta.removed'),
        },
        manifest: {
          canonicalRoot: manifest.canonicalRoot,
          entries:
            manifest.entries as import('../src/shared/project-workspace/resident-project-workspace-service').ResidentProjectAuthorityObservation['manifest']['entries'],
        },
      };
    },
    release(projectRoot) {
      invokeResidentHost('daemon-project-release', JSON.stringify({ projectRoot }));
    },
  };
}

function scopedResidentReadAuthority(
  fileSystem: ProjectWorkspaceFileSystem,
): import('../src/cli/application').CliScopedReadAuthority {
  const authority = residentProjectAuthority();
  const emptyAssetSourcePaths = new Set<string>();
  const capture = async (
    projectRoot: string,
    requiredSemanticPaths: readonly string[],
    configure: boolean,
  ): Promise<ScopedReadAuthorityToken> => {
    const canonicalRoot = await fileSystem.realpath(projectRoot);
    const assetsRequired = requiredSemanticPaths.some(
      (path) => path === '/assets' || path.startsWith('/assets/'),
    );
    const observation = await authority.observe({
      projectRoot: canonicalRoot,
      ...(configure
        ? {
            ...scopedResidentObservationConfiguration(assetsRequired),
          }
        : {}),
      includeManifestEntries: true,
    });
    return Object.freeze({
      canonicalRoot,
      requiredSemanticPaths: Object.freeze([...requiredSemanticPaths]),
      authoritySignature: scopedAuthoritySignature(
        observation,
        requiredSemanticPaths,
        emptyAssetSourcePaths,
      ),
      relevantDeltaPaths: scopedAuthorityRelevantDeltaPaths(
        observation,
        requiredSemanticPaths,
        emptyAssetSourcePaths,
      ),
    });
  };
  return {
    captureScopedReadAuthority(projectRoot, requiredSemanticPaths) {
      return capture(projectRoot, requiredSemanticPaths, true);
    },
    async verifyScopedReadAuthority(token) {
      const current = await capture(token.canonicalRoot, token.requiredSemanticPaths, false);
      return (
        current.relevantDeltaPaths.length === 0 &&
        current.authoritySignature === token.authoritySignature
      );
    },
  };
}

function trace(message: string): void {
  if (process.env.NOVELTEA_CLI_TRACE === '1') process.stderr.write(`[scriptc-island] ${message}\n`);
}

async function retainExactResidentValidation(
  commandResult: import('../src/cli/contracts').NovelTeaCliCommandResult,
  invokeHost: ScriptcHostInvoke,
): Promise<void> {
  const projectRoot = commandResult.envelope.projectRoot;
  const diagnostics = commandResult.envelope.diagnostics;
  if (
    typeof projectRoot !== 'string' ||
    diagnostics.some((item) => item.severity === 'error' && item.code.startsWith('native.'))
  )
    return;
  invokeHost(
    'daemon-authoring-validation-result',
    JSON.stringify({
      semanticKey: NOVELTEA_AUTHORING_VALIDATION_SEMANTIC_KEY,
      result: {
        success: commandResult.envelope.success,
        exitCode: commandResult.exitCode,
        diagnostics,
        editorDiagnostics: commandResult.editorDiagnostics ?? [],
      },
    }),
  );
}

function createNativeTools(
  invoke: ScriptcHostInvoke,
  disposable = false,
): NovelTeaCliNativeToolService {
  const call = (operation: string, request: unknown): unknown =>
    JSON.parse(invoke(operation, JSON.stringify(request))) as unknown;
  return {
    validationCacheIdentity: 'noveltea-cli-native',
    ...(disposable
      ? {
          async registerStagedOutput(path: string) {
            const response = call('daemon-register-staged-output', { path }) as {
              ok?: boolean;
              error?: string;
            };
            if (response.ok !== true)
              throw new Error(response.error ?? 'Failed to register staged output cleanup.');
          },
          async commitComfyUiAssetPublication(request: unknown) {
            const response = call('daemon-commit-comfyui-assets', request) as {
              ok?: boolean;
              result?: unknown;
              error?: string;
            };
            if (response.ok !== true)
              throw new Error(response.error ?? 'Failed to commit ComfyUI Asset publication.');
            return response.result;
          },
        }
      : {}),
    async compileShaders(shaderProject, options) {
      const { sourceOverlays, ...nativeOptions } = options;
      const invokeCompile = (projectRoot = nativeOptions.projectRoot) =>
        call('compile-shaders', {
          shaderProject,
          options: { ...nativeOptions, projectRoot },
        }) as Awaited<ReturnType<NovelTeaCliNativeToolService['compileShaders']>>;
      if (sourceOverlays === undefined || !nativeOptions.projectRoot) return invokeCompile();

      const overlayRoot = await mkdtemp(path.join(os.tmpdir(), 'noveltea-pinned-shaders-'));
      try {
        for (const [relativePath, text] of Object.entries(sourceOverlays)) {
          const normalized = path.posix.normalize(relativePath.replaceAll('\\', '/'));
          if (
            !normalized.startsWith('shaders/') ||
            normalized !== relativePath.replaceAll('\\', '/') ||
            normalized.split('/').includes('..')
          )
            throw new Error(`Invalid pinned shader source path: ${relativePath}`);
          const destination = path.join(overlayRoot, normalized);
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, text, 'utf8');
        }
        const response = invokeCompile(overlayRoot);
        const remap = (value: string | undefined) => {
          if (!value) return value;
          const relative = path.relative(overlayRoot, value);
          return !relative.startsWith('..') && !path.isAbsolute(relative)
            ? path.join(nativeOptions.projectRoot!, relative)
            : value;
        };
        return {
          ...response,
          diagnostics: response.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            sourcePath: remap(diagnostic.sourcePath),
            path: remap(diagnostic.path),
          })),
        };
      } finally {
        await rm(overlayRoot, { recursive: true, force: true });
      }
    },
    async runHeadlessTest(request) {
      return call('run-test', request);
    },
    async runTestSuite(request) {
      return call('run-test-suite', request);
    },
    async runUiTest(request) {
      return call('run-ui-test', request);
    },
    async exportPackage(request) {
      return call('export-package', request);
    },
    async validateFontCoverage(request) {
      return call('font-coverage', request) as LocalizationFontCoverageResponse;
    },
    async inspectFont(absolutePath) {
      return call('font-inspect', { path: absolutePath }) as {
        ok: boolean;
        glyphCount?: number;
        error?: string;
      };
    },
    async validateMedia(absolutePath, kind) {
      const [{ validateImportedAudioVideo }, { installedMediaTool }] = await Promise.all([
        import('../src/main/services/media-import-validation-service'),
        import('../src/main/services/media-preparation-service'),
      ]);
      await validateImportedAudioVideo(absolutePath, kind, {
        tool: installedMediaTool(invoke('cli-executable-path', '')),
        run: async (executable, args) => {
          const response = JSON.parse(
            invoke(
              'run-process',
              JSON.stringify({
                command: executable,
                args: [...args],
                maxBuffer: 32768,
                timeoutMs: 20000,
              }),
            ),
          ) as { ok: boolean; stdout?: string; stderr?: string; error?: string };
          if (!response.ok) throw new Error(response.error ?? 'Media decoding failed.');
          return { stdout: response.stdout ?? '', stderr: response.stderr ?? '' };
        },
      });
    },
    shaderc(arguments_) {
      const response = call('shaderc', arguments_) as { exitCode?: unknown };
      if (!Number.isSafeInteger(response.exitCode) || (response.exitCode as number) < 0)
        throw new Error(
          `Native shaderc returned invalid exit code '${String(response.exitCode)}'.`,
        );
      return response.exitCode as number;
    },
    texturec(arguments_) {
      const response = call('texturec', arguments_) as { exitCode?: unknown };
      if (!Number.isSafeInteger(response.exitCode) || (response.exitCode as number) < 0)
        throw new Error(
          `Native texturec returned invalid exit code '${String(response.exitCode)}'.`,
        );
      return response.exitCode as number;
    },
  };
}

async function configureScriptcPlatformHost(invoke: ScriptcHostInvoke): Promise<void> {
  const call = <T>(operation: string, request: unknown): T => {
    const response = JSON.parse(invoke(operation, JSON.stringify(request))) as unknown;
    if (
      response &&
      typeof response === 'object' &&
      (response as { ok?: unknown }).ok === false &&
      typeof (response as { error?: unknown }).error === 'string'
    )
      throw new Error((response as { error: string }).error);
    return response as T;
  };
  const [{ configureImageInspectionService }, { configurePlatformHostService }] = await Promise.all(
    [
      import('../src/main/services/image-inspection-service'),
      import('../src/main/services/platform-host-service'),
    ],
  );
  const inspectImage = async (sourcePath: string) =>
    call<{
      width: number;
      height: number;
      hasAlpha: boolean;
      orientation?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
      space?: string;
      alphaBounds?: { left: number; top: number; right: number; bottom: number };
    }>('image-inspect', { sourcePath });
  configureImageInspectionService(inspectImage);
  configurePlatformHostService({
    async runProcess(request) {
      return call('run-process', request);
    },
    inspectImage,
    async resizeImageToPng(request) {
      call('image-resize-png', request);
    },
    async createArchive(request) {
      call('create-archive', request);
    },
    async fileMode(path, fallback) {
      return call('file-mode', { path, fallback });
    },
    async availableDiskSpace(path) {
      return call('disk-space', { path });
    },
  });
}

function result(exitCode: number, stdout = '', stderr = ''): string {
  return JSON.stringify([exitCode, stdout, stderr]);
}

async function runInternalCommand(
  argv: readonly string[],
  nativeTools: NovelTeaCliNativeToolService,
  invokeHost: ScriptcHostInvoke,
): Promise<string | null> {
  if (argv[0] === '__shaderc-batch') {
    if (argv.length !== 1)
      return result(2, '', 'Internal shaderc batch bridge accepts no arguments.\n');
    const parsed = JSON.parse(invokeHost('read-stdin', '') || '[]') as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (entry) => !Array.isArray(entry) || entry.some((argument) => typeof argument !== 'string'),
      )
    )
      return result(2, '', 'Internal shaderc batch bridge requires an array of string arrays.\n');
    for (const command of parsed as string[][]) {
      const exitCode = nativeTools.shaderc(command);
      if (exitCode !== 0) return result(exitCode);
    }
    return result(0);
  }

  if (argv[0] !== '__editor-native') return null;
  const operation = argv[1];
  if (argv.length !== 2 || !operation)
    return result(2, '', 'Internal editor native bridge requires exactly one operation.\n');
  const input = JSON.parse(invokeHost('read-stdin', '') || '{}') as Record<string, unknown>;
  let response: unknown;
  if (operation === 'compile-shaders')
    response = await nativeTools.compileShaders(input.shaderProject, input.options ?? {});
  else if (operation === 'run-test') response = await nativeTools.runHeadlessTest(input);
  else if (operation === 'run-test-suite') {
    if (!nativeTools.runTestSuite)
      return result(1, '', 'Native test-suite operation is unavailable.\n');
    response = await nativeTools.runTestSuite(input);
  } else if (operation === 'run-ui-test') response = await nativeTools.runUiTest(input);
  else if (operation === 'export-package') response = await nativeTools.exportPackage(input);
  else if (operation === 'font-coverage') {
    if (nativeTools.validateFontCoverage === undefined)
      return result(1, '', 'Font coverage native validation is unavailable.\n');
    response = await nativeTools.validateFontCoverage(
      input as unknown as LocalizationFontCoverageRequest,
    );
  } else if (operation === 'font-inspect') {
    if (nativeTools.inspectFont === undefined)
      return result(1, '', 'Native font inspection is unavailable.\n');
    if (typeof input.path !== 'string')
      return result(2, '', 'Native font inspection requires a path.\n');
    response = await nativeTools.inspectFont(input.path);
  } else if (operation === 'native-project-commands') {
    // Certification-only parallel native Runtime Package preparation, not a
    // public authoring command cutover. Limit the internal bridge to the one
    // read-only operation needed by the end-to-end export differential.
    if (input.action !== 'runtime-package-preparation')
      return result(2, '', 'Internal native Project preparation requires a runtime intent.\n');
    response = JSON.parse(invokeHost('native-project-commands', JSON.stringify(input)));
  } else if (operation === 'native-runtime-compile-certify') {
    // Certificate-only parity seam: consume the exact native Project result
    // through the same existing runtime artifact compiler as the public CLI,
    // not a second native compiler or a profile-only export comparison.
    if (typeof input.projectRoot !== 'string' || !input.projectRoot)
      return result(2, '', 'Native runtime compilation requires a Project root.\n');
    const nativePrepared = JSON.parse(
      invokeHost(
        'native-project-commands',
        JSON.stringify({
          action: 'runtime-package-preparation',
          projectRoot: input.projectRoot,
        }),
      ),
    ) as { ok?: boolean; project?: unknown; profile?: unknown };
    if (!nativePrepared.ok || !nativePrepared.project || !nativePrepared.profile)
      return result(
        1,
        `${JSON.stringify({ ok: false, error: 'Native runtime preparation failed.' })}\n`,
      );
    const cryptoModule = await import('../src/shared/web-crypto');
    cryptoModule.configureSha256BytesImplementation(async (bytes) =>
      createHash('sha256').update(bytes).digest('hex'),
    );
    await configureScriptcPlatformHost(invokeHost);
    const [schema, preparation, adapters] = await Promise.all([
      import('../src/shared/project-schema/authoring-project'),
      import('../src/shared/runtime-artifact-preparation'),
      import('../src/main/services/node-runtime-artifact-adapters'),
    ]);
    const nativeProject = nativePrepared.project as Record<string, unknown>;
    const identity = nativeProject.project as { id: string; name: string };
    const defaults = schema.createAuthoringProject({ id: identity.id, name: identity.name });
    const project = schema.authoringProjectSchema.parse({
      ...defaults,
      ...nativeProject,
      editor: { ...defaults.editor, ...(nativeProject.editor as Record<string, unknown>) },
    });
    const prepared = await preparation.prepareRuntimeArtifact({
      project,
      projectRoot: input.projectRoot,
      profile:
        nativePrepared.profile as import('../src/shared/project-schema/authoring-export').ExportProfileData,
      intent: 'runtime-package-export',
      shaderCompiler: adapters.nodeShaderCompilerAdapter((shaderProject, options) =>
        nativeTools.compileShaders(shaderProject, options),
      ),
      paths: adapters.createNodeRuntimeArtifactPaths(
        () => invokeHost('cli-executable-path', ''),
        hostMediaToolRunner(invokeHost),
        hostNativeAlphaEncoder(invokeHost),
      ),
    });
    const gameplay = prepared.status === 'prepared' ? prepared.assessment.gameplayJson : undefined;
    const diagnostics =
      prepared.status === 'prepared' ? prepared.assessment.diagnostics : prepared.diagnostics;
    response = {
      ok: prepared.status === 'prepared' && typeof gameplay === 'string',
      status: prepared.status,
      gameplayPresent: typeof gameplay === 'string',
      ...(gameplay
        ? { gameplaySha256: `sha256:${createHash('sha256').update(gameplay).digest('hex')}` }
        : {}),
      diagnostics: diagnostics
        .filter((issue) => issue.severity === 'error')
        .map((issue) => ({
          code: issue.code,
          severity: issue.severity,
          path: issue.path,
          message: issue.message,
        }))
        .slice(0, 16),
    };
  } else return result(2, '', `Unknown internal editor native operation '${operation}'.\n`);

  const record =
    response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  return result(record.ok === true ? 0 : 1, `${JSON.stringify(response)}\n`);
}

export interface ScriptcInvocationContext {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly terminal?: import('../src/cli/commands/types').CliTerminalContext;
  readonly cancellationProbe?: () => boolean;
  /** The wrapper monitors cancellation across snapshot hydration and command execution. */
  readonly cancellationSignal?: AbortSignal;
  readonly observeCancellation?: () => void;
  readonly residentProjectSessions?: boolean;
  readonly projectSessionIdleMs?: number;
  readonly residentProjectSessionEpoch?: number;
  readonly residentProjectSnapshot?: Readonly<{
    projectRoot: string;
    snapshotText: string;
    ownerMetadataText: string;
  }>;
  readonly pinnedProjectSnapshot?: Readonly<{
    projectRoot: string;
    snapshotText: string;
  }>;
  readonly prepareResidentSnapshotOnly?: boolean;
}

async function createPinnedRuntimeArtifactPaths(
  fileSystem: import('../src/shared/project-workspace/project-workspace-file-system').ProjectWorkspaceFileSystem,
  projectRoot: string,
  inputs: import('../src/shared/project-workspace/resident-project-workspace-service').PinnedPortableResidentProjectInputs,
  cliExecutable: () => string,
  mediaRunner: (executable: string, args: readonly string[]) => { stdout: string; stderr: string },
  nativeAlphaEncoder: import('../src/main/services/transparent-video-tracer').NativeAlphaEncoder,
): Promise<import('../src/shared/runtime-artifact-preparation').RuntimeArtifactPathAdapter> {
  const [nodePaths, pinnedAssets] = await Promise.all([
    import('../src/main/services/node-runtime-artifact-adapters'),
    import('../src/cli/pinned-external-assets'),
  ]);
  const externalByPath = new Map(
    inputs.externalAssets.map((entry) => [entry.path.replaceAll('\\', '/'), entry]),
  );
  return {
    ...nodePaths.createNodeRuntimeArtifactPaths(cliExecutable, mediaRunner, nativeAlphaEncoder),
    async readProjectTextSources(root, entries) {
      const results = new Map<
        string,
        Awaited<
          ReturnType<NonNullable<typeof nodePaths.nodeRuntimeArtifactPaths.readProjectTextSources>>
        >[number]
      >();
      const external = [] as (typeof entries)[number][];
      for (const entry of entries) {
        const relative = entry.projectRelativePath.replaceAll('\\', '/').replace(/^\/+/, '');
        const source = inputs.projectTextSources[relative];
        if (source) {
          results.set(
            entry.assetId,
            entry.expectedContentHash === null || source.contentHash === entry.expectedContentHash
              ? {
                  status: 'ready',
                  assetId: entry.assetId,
                  projectRelativePath: relative,
                  contentHash: source.contentHash,
                  text: source.text,
                }
              : { status: 'unavailable', assetId: entry.assetId },
          );
          continue;
        }
        if (entry.expectedContentHash !== null) external.push(entry);
        else results.set(entry.assetId, { status: 'unavailable', assetId: entry.assetId });
      }
      if (external.length > 0) {
        const expectations = external
          .map((entry) =>
            externalByPath.get(entry.projectRelativePath.replaceAll('\\', '/').replace(/^\/+/, '')),
          )
          .filter((entry) => entry !== undefined);
        if (expectations.length === external.length) {
          const diagnostics = await pinnedAssets.verifyPinnedExternalAssets(
            fileSystem,
            projectRoot,
            expectations,
          );
          if (diagnostics.length === 0) {
            const observed = await nodePaths.nodeRuntimeArtifactPaths.readProjectTextSources!(
              root,
              external,
            );
            for (const entry of observed) results.set(entry.assetId, entry);
          }
        }
        for (const entry of external)
          if (!results.has(entry.assetId))
            results.set(entry.assetId, { status: 'unavailable', assetId: entry.assetId });
      }
      return entries.map(
        (entry) => results.get(entry.assetId) ?? { status: 'unavailable', assetId: entry.assetId },
      );
    },
  };
}

function hostNativeAlphaEncoder(
  invokeHost: ScriptcHostInvoke,
): import('../src/main/services/transparent-video-tracer').NativeAlphaEncoder {
  return (request) => {
    const result = JSON.parse(
      invokeHost('alpha-encode', JSON.stringify(request)),
    ) as import('../src/main/services/transparent-video-tracer').NativeAlphaEncodeResult;
    if (result.ok !== true) throw new Error(result.error ?? 'Native FFmpeg alpha encoding failed.');
    return result;
  };
}

function hostMediaToolRunner(invokeHost: ScriptcHostInvoke) {
  return (executable: string, args: readonly string[]) => {
    const response = JSON.parse(
      invokeHost('run-process', JSON.stringify({ command: executable, args: [...args] })),
    ) as { ok: boolean; stdout?: string; stderr?: string; error?: string };
    if (response.ok !== true) throw new Error(response.error ?? 'Media-tool execution failed.');
    return { stdout: response.stdout ?? '', stderr: response.stderr ?? '' };
  };
}

export async function runNovelTeaScriptcIsland(
  argvText: string,
  invokeHost: ScriptcHostInvoke,
  forceRuntimeCacheRebuild = false,
  invocationContext: ScriptcInvocationContext = {},
): Promise<string> {
  const cancellationController = invocationContext.cancellationProbe ? new AbortController() : null;
  if (invocationContext.cancellationProbe?.()) cancellationController?.abort();
  const cancellationPoll = invocationContext.cancellationProbe
    ? setInterval(() => {
        if (invocationContext.cancellationProbe?.()) cancellationController?.abort();
      }, 25)
    : null;
  const previousEnvironment = invocationContext.environment ? { ...process.env } : null;
  if (invocationContext.environment) {
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const [key, value] of Object.entries(invocationContext.environment))
      process.env[key] = value;
  }
  try {
    return await runNovelTeaScriptcIslandScoped(
      argvText,
      invokeHost,
      forceRuntimeCacheRebuild,
      cancellationController
        ? {
            ...invocationContext,
            cancellationSignal: cancellationController.signal,
            observeCancellation: () => cancellationController.abort(),
          }
        : invocationContext,
    );
  } finally {
    if (cancellationPoll) clearInterval(cancellationPoll);
    if (previousEnvironment) {
      for (const key of Object.keys(process.env)) delete process.env[key];
      for (const [key, value] of Object.entries(previousEnvironment))
        if (value !== undefined) process.env[key] = value;
    }
  }
}

async function runNovelTeaScriptcIslandScoped(
  argvText: string,
  invokeHost: ScriptcHostInvoke,
  forceRuntimeCacheRebuild: boolean,
  invocationContext: ScriptcInvocationContext,
): Promise<string> {
  const argv = JSON.parse(argvText) as string[];
  const environment = invocationContext.environment ?? process.env;
  const publishResidentProjectSessionCount = () => {
    if (!invocationContext.residentProjectSessions) return;
    invokeHost('daemon-project-sessions', String(residentWorkspace?.residentSessionCount() ?? 0));
  };
  if (invocationContext.residentProjectSessions) {
    residentInvokeHost = invokeHost;
    if (residentWorkspace && invocationContext.projectSessionIdleMs) {
      const evicted = residentWorkspace.evictIdleSessions(invocationContext.projectSessionIdleMs);
      if (evicted > 0) trace(`resident Project idle eviction: ${String(evicted)}`);
    }
    publishResidentProjectSessionCount();
  }
  const effectiveArgv = argv;
  const nativeTools = createNativeTools(invokeHost, !!invocationContext.pinnedProjectSnapshot);
  const internal = await runInternalCommand(effectiveArgv, nativeTools, invokeHost);
  if (internal !== null) return internal;

  trace('bootstrap import starting');
  const { bootstrapNovelTeaCli } = await import('../src/cli/bootstrap');
  trace('bootstrap import completed');
  const bootstrap = bootstrapNovelTeaCli(effectiveArgv);
  if (bootstrap.complete)
    return result(bootstrap.result.exitCode, bootstrap.result.stdout, bootstrap.result.stderr);
  const command = bootstrap.globals.command;
  const family = command[0];
  const operation = command[1];

  let platformTools: NovelTeaCliPlatformToolService | undefined;

  const platformNeedsHost =
    family === 'platform' &&
    (operation === 'export' || (operation === 'template' && command[2] === 'install'));
  const projectNeedsHost = family === 'project' && operation === 'export';
  if (
    family === 'comfyui' ||
    (family === 'asset' && operation === 'import') ||
    platformNeedsHost ||
    projectNeedsHost
  ) {
    trace('platform host configuration starting');
    await configureScriptcPlatformHost(invokeHost);
  }

  const projectIndependentPlatform =
    family === 'platform' && (operation === 'template' || operation === 'config');
  const scopedProjectPreparation =
    (family === 'asset' && operation === 'audit') ||
    (family === 'platform' && operation === 'profiles');
  let fileSystem:
    | import('../src/shared/project-workspace/project-workspace-file-system').ProjectWorkspaceFileSystem
    | undefined;
  let workspace:
    | import('../src/shared/project-workspace/project-workspace-service').ProjectWorkspaceService
    | undefined;
  let pinnedExternalAssets:
    | readonly import('../src/cli/pinned-external-assets').PinnedExternalAssetExpectation[]
    | undefined;
  let pinnedProjectTextSources:
    | import('../src/shared/project-workspace/resident-project-workspace-service').PinnedPortableResidentProjectInputs['projectTextSources']
    | undefined;
  let pinnedNativePreparation:
    | import('../src/shared/project-workspace/resident-project-workspace-service').NativeResidentProjectPreparation
    | null = null;
  let pinnedRuntimeBuildCacheInputs:
    | import('../src/shared/runtime-build-cache').PinnedRuntimeBuildCacheInputs
    | null
    | undefined;
  let pinnedRuntimeArtifactPaths:
    | import('../src/shared/runtime-artifact-preparation').RuntimeArtifactPathAdapter
    | undefined;
  if (!projectIndependentPlatform) {
    trace('scoped filesystem import starting');
    const [fileSystemModule, metadataModule] = await Promise.all([
      import('../src/shared/project-workspace/node-project-workspace-file-system'),
      import('./noveltea-scriptc-path-metadata'),
    ]);
    trace('scoped filesystem import completed');
    if (invocationContext.residentProjectSessions && residentFileSystem)
      fileSystem = residentFileSystem;
    else {
      fileSystem = fileSystemModule.createNodeProjectWorkspaceFileSystem(
        metadataModule.createScriptcPathMetadataReader(
          invocationContext.residentProjectSessions ? invokeResidentHost : invokeHost,
        ),
      );
      if (invocationContext.residentProjectSessions) residentFileSystem = fileSystem;
    }
    if (!scopedProjectPreparation) {
      trace('workspace services import starting');
      const [serviceModule, transactionModule, cryptoModule] = await Promise.all([
        import('../src/shared/project-workspace/project-workspace-service'),
        import('../src/shared/project-workspace/project-workspace-transaction'),
        import('../src/shared/web-crypto'),
      ]);
      cryptoModule.configureSha256BytesImplementation(async (bytes) =>
        createHash('sha256').update(bytes).digest('hex'),
      );
      const createWorkspace = (
        workspaceFileSystem: import('../src/shared/project-workspace/project-workspace-file-system').ProjectWorkspaceFileSystem,
      ) => {
        const daemonTransactionLifecycle = invocationContext.residentProjectSessions
          ? {
              enterCriticalSection() {
                const response = JSON.parse(invokeResidentHost('daemon-enter-critical', '')) as {
                  ok?: boolean;
                  error?: string;
                };
                if (response.ok !== true)
                  throw new Error(response.error ?? 'Failed to enter daemon transaction boundary.');
              },
              leaveCriticalSection() {
                const response = JSON.parse(invokeResidentHost('daemon-leave-critical', '')) as {
                  ok?: boolean;
                  error?: string;
                };
                if (response.ok !== true)
                  throw new Error(response.error ?? 'Failed to leave daemon transaction boundary.');
              },
            }
          : undefined;
        return new serviceModule.ProjectWorkspaceService(
          workspaceFileSystem,
          new transactionModule.ProjectWorkspaceTransactionService(
            workspaceFileSystem,
            {
              async isProcessAlive(pid) {
                const value = (
                  invocationContext.residentProjectSessions ? invokeResidentHost : invokeHost
                )('process-alive', String(pid));
                return value === 'true' ? true : value === 'false' ? false : null;
              },
            },
            process.pid,
            randomUUID,
            daemonTransactionLifecycle,
          ),
        );
      };
      workspace = createWorkspace(fileSystem);
      if (
        (invocationContext.residentProjectSessions || invocationContext.pinnedProjectSnapshot) &&
        !residentWorkspace
      ) {
        const { ResidentProjectWorkspaceService } =
          await import('../src/shared/project-workspace/resident-project-workspace-service');
        residentWorkspace = new ResidentProjectWorkspaceService(
          fileSystem,
          createWorkspace,
          invocationContext.residentProjectSessions ? residentProjectAuthority() : undefined,
          invocationContext.residentProjectSessionEpoch,
        );
      }
      if (invocationContext.residentProjectSnapshot && residentWorkspace) {
        const retained = invocationContext.residentProjectSnapshot;
        const rehydrated = await residentWorkspace.rehydratePortableSnapshot(
          retained.projectRoot,
          retained.snapshotText,
          retained.ownerMetadataText,
        );
        if (rehydrated) trace(`resident Project snapshot rehydrated: ${retained.projectRoot}`);
      }
      if (invocationContext.pinnedProjectSnapshot && residentWorkspace) {
        const pinned = invocationContext.pinnedProjectSnapshot;
        const hydrated = await residentWorkspace.hydratePortableSnapshot(
          pinned.projectRoot,
          pinned.snapshotText,
        );
        if (!hydrated)
          throw new Error(
            'Pinned Project generation could not be hydrated from its portable snapshot.',
          );
        const pinnedInputs = await residentWorkspace.pinnedPortableInputs(pinned.projectRoot);
        if (!pinnedInputs)
          throw new Error('Pinned Project generation did not retain its decoded portable inputs.');
        pinnedExternalAssets = pinnedInputs.externalAssets;
        pinnedProjectTextSources = pinnedInputs.projectTextSources;
        pinnedNativePreparation = pinnedInputs.nativePreparation;
        const { pinnedRuntimeBuildCacheInputsFromAuthority } =
          await import('../src/shared/runtime-build-cache');
        const openedPinned = await residentWorkspace.open(pinned.projectRoot);
        if (!openedPinned.ok)
          throw new Error('Pinned Project generation could not expose its decoded Project state.');
        pinnedRuntimeBuildCacheInputs = pinnedRuntimeBuildCacheInputsFromAuthority(
          openedPinned.snapshot,
          pinnedInputs.physicalAuthority,
        );
        pinnedRuntimeArtifactPaths = await createPinnedRuntimeArtifactPaths(
          fileSystem,
          pinned.projectRoot,
          pinnedInputs,
          () => invokeHost('cli-executable-path', ''),
          hostMediaToolRunner(invokeHost),
          hostNativeAlphaEncoder(invokeHost),
        );
        trace(`pinned Project snapshot hydrated: ${pinned.projectRoot}`);
        // Certification-only interlock: release the worker after the resident owner has
        // promoted new disk sources, while this worker retains its older decoded inputs.
        const marker =
          environment.NOVELTEA_CLI_CERTIFICATION === '1'
            ? environment.NOVELTEA_CLI_CERTIFICATION_AFTER_SNAPSHOT_MARKER
            : undefined;
        if (marker) {
          await writeFile(marker, 'hydrated');
          const deadline = Date.now() + 30_000;
          while (!existsSync(`${marker}.release`)) {
            if (invocationContext.cancellationProbe?.()) {
              invocationContext.observeCancellation?.();
              await writeFile(`${marker}.cancelled`, 'cancelled');
              break;
            }
            if (Date.now() >= deadline)
              throw new Error('Snapshot certification interlock timed out.');
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
      }
    }
  }

  const runtimeArtifactPaths =
    pinnedRuntimeArtifactPaths ??
    (['package', 'test', 'platform', 'project'].includes(family)
      ? (
          await import('../src/main/services/node-runtime-artifact-adapters')
        ).createNodeRuntimeArtifactPaths(
          () => invokeHost('cli-executable-path', ''),
          hostMediaToolRunner(invokeHost),
          hostNativeAlphaEncoder(invokeHost),
        )
      : undefined);

  if (family === 'platform') {
    trace('platform tools import starting');
    const { createNovelTeaCliPlatformToolService } =
      await import('../src/cli/platform-tool-service-node');
    trace('platform tools import completed');
    platformTools = createNovelTeaCliPlatformToolService(nativeTools, {
      runtimeArtifactPaths,
      pinnedProjectTextSources,
    });
  }

  let agentKitPayload: import('../src/cli/agent-kit').NovelTeaAgentKitPayload | undefined;
  if (family === 'agent' && operation === 'sync') {
    const [agentKit, source] = await Promise.all([
      import('../src/cli/agent-kit'),
      import('./noveltea-scriptc-agent-kit-source'),
    ]);
    agentKitPayload = agentKit.createNovelTeaAgentKitPayload(
      source.scriptcAgentKitSourceFiles,
      source.scriptcAgentKitProvenance,
      source.scriptcAgentKitSystemLayoutSourceFiles,
    );
  }

  let embeddedBuiltInFiles: Readonly<Record<string, string>> | undefined;
  if (family === 'comfyui') {
    const comfyUi = await import('./noveltea-scriptc-comfyui-workflows');
    embeddedBuiltInFiles = comfyUi.scriptcComfyUiWorkflowFiles;
  }

  try {
    let validationProfileText = '';
    const residentSessionCountBefore = residentWorkspace?.residentSessionCount() ?? 0;
    trace('application import starting');
    const { runNovelTeaCli } = await import('../src/cli/application');
    trace('application import completed');
    trace('application invocation starting');
    let commandResult: Awaited<ReturnType<typeof runNovelTeaCli>>;
    try {
      commandResult = await runNovelTeaCli(effectiveArgv, {
        ...(invocationContext.cwd ? { cwd: invocationContext.cwd } : {}),
        ...(invocationContext.terminal ? { terminal: invocationContext.terminal } : {}),
        ...(fileSystem ? { fileSystem } : {}),
        ...(workspace ? { workspace } : {}),
        ...(invocationContext.residentProjectSessions && residentWorkspace
          ? { residentWorkspace }
          : invocationContext.pinnedProjectSnapshot && residentWorkspace
            ? { residentWorkspace, trustPinnedResidentSnapshot: true }
            : {}),
        ...(scopedProjectPreparation &&
        invocationContext.residentProjectSessions &&
        fileSystem &&
        !residentWorkspace
          ? { scopedReadAuthority: scopedResidentReadAuthority(fileSystem) }
          : {}),
        nativeTools,
        ...(environment.NOVELTEA_CLI_CERTIFICATION === '1' &&
        environment.NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE === '1'
          ? {
              nativeProjectCommands: (request: Readonly<Record<string, unknown>>) =>
                JSON.parse(invokeHost('native-project-commands', JSON.stringify(request))),
            }
          : {}),
        ...(runtimeArtifactPaths ? { runtimeArtifactPaths } : {}),
        ...(platformTools ? { platformTools } : {}),
        ...(embeddedBuiltInFiles
          ? { comfyUiWorkflowLibraryOptions: { embeddedBuiltInFiles } }
          : {}),
        ...(invocationContext.cancellationSignal
          ? { abortSignal: invocationContext.cancellationSignal }
          : {}),
        ...(invocationContext.residentProjectSessions && !bootstrap.globals.json
          ? {
              onPlatformProgress: (stage: string, message: string) => {
                invokeHost('emit-progress', JSON.stringify({ stage, message }));
              },
              onComfyUiProgress: (stage: string, message: string) => {
                invokeHost('emit-progress', JSON.stringify({ stage, message }));
              },
            }
          : {}),
        ...(agentKitPayload ? { agentKitPayload } : {}),
        readStdinText: () => invokeHost('read-stdin', ''),
        forceRuntimeCacheRebuild,
        // A native whole-result miss must not become a second whole-result hit inside the island,
        // but stale generations can still contribute individually proven source/validation work.
        skipAuthoringWholeResultCache: true,
        ...(invocationContext.prepareResidentSnapshotOnly
          ? { prepareResidentSnapshotOnly: true }
          : {}),
        ...(invocationContext.pinnedProjectSnapshot
          ? {
              pinnedExternalAssets,
              pinnedProjectTextSources,
              pinnedRuntimeBuildCacheInputs,
              pinnedNativePreparation: {
                projectRoot: invocationContext.pinnedProjectSnapshot.projectRoot,
                preparation: pinnedNativePreparation,
              },
            }
          : {}),
        onAuthoringValidationInstrumentation:
          environment.NOVELTEA_CLI_VALIDATION_PROFILE === '1'
            ? (instrumentation) => {
                validationProfileText = `[validation-profile] ${JSON.stringify(instrumentation)}\n`;
              }
            : undefined,
      });
    } finally {
      if (invocationContext.residentProjectSessionEpoch !== undefined)
        announceResidentProjectGenerations();
    }
    if (
      family === 'validate' &&
      invocationContext.residentProjectSessionEpoch !== undefined &&
      !invocationContext.prepareResidentSnapshotOnly &&
      novelTeaResidentProjectSessionCount() > 0
    )
      await retainExactResidentValidation(commandResult, invokeHost);
    // #500 parallel native daemon certification. The C++ disk Project graph
    // stays resident in this existing Project owner, but cannot affect the
    // public TS validation result, diagnostic presentation, or exit status.
    if (
      family === 'validate' &&
      invocationContext.residentProjectSessionEpoch !== undefined &&
      !invocationContext.prepareResidentSnapshotOnly &&
      environment.NOVELTEA_CLI_CERTIFICATION === '1' &&
      environment.NOVELTEA_CLI_CERTIFICATION_NATIVE_DISK_VALIDATION === '1' &&
      typeof commandResult.envelope.projectRoot === 'string'
    ) {
      const native = JSON.parse(
        invokeHost(
          'native-disk-project-validation',
          JSON.stringify({ projectRoot: commandResult.envelope.projectRoot }),
        ),
      ) as {
        ok?: boolean;
        error?: string;
        valid?: boolean;
        warm?: boolean;
        diagnostics?: unknown[];
        cliDiagnostics?: unknown[];
        work?: unknown;
      };
      if (native.ok !== true)
        throw new Error(native.error ?? 'Parallel native disk validation failed.');
      // Certification diagnostics remain on stderr; JSON CLI output is unchanged.
      validationProfileText +=
        '[native-disk-validation] ' +
        JSON.stringify({
          valid: native.valid,
          warm: native.warm,
          diagnostics: native.diagnostics,
          cliDiagnostics: native.cliDiagnostics,
          work: native.work,
          oracle: {
            success: commandResult.envelope.success,
            exitCode: commandResult.exitCode,
            diagnostics: commandResult.envelope.diagnostics,
          },
        }) +
        '\n';
    }
    // #501: the existing daemon's CLI result remains the production oracle.
    // Observe native record/provenance semantics without mutating disk or
    // introducing a second authoring command dispatcher for users.
    if (
      family === 'usages' &&
      !invocationContext.prepareResidentSnapshotOnly &&
      environment.NOVELTEA_CLI_CERTIFICATION === '1' &&
      environment.NOVELTEA_CLI_CERTIFICATION_NATIVE_COMMANDS === '1' &&
      typeof commandResult.envelope.projectRoot === 'string' &&
      bootstrap.globals.command.length === 3
    ) {
      const native = JSON.parse(
        invokeHost(
          'native-project-commands',
          JSON.stringify({
            action: 'entity-usages',
            projectRoot: commandResult.envelope.projectRoot,
            collection: bootstrap.globals.command[1],
            id: bootstrap.globals.command[2],
          }),
        ),
      ) as { ok?: boolean; error?: string; usages?: unknown[] };
      validationProfileText +=
        '[native-cli-usages] ' +
        JSON.stringify({ native, oracle: commandResult.envelope.usages }) +
        '\n';
    }
    if (
      family === 'entity' &&
      operation === 'inspect' &&
      invocationContext.residentProjectSessionEpoch !== undefined &&
      !invocationContext.prepareResidentSnapshotOnly &&
      environment.NOVELTEA_CLI_CERTIFICATION === '1' &&
      environment.NOVELTEA_CLI_CERTIFICATION_NATIVE_COMMANDS === '1' &&
      typeof commandResult.envelope.projectRoot === 'string' &&
      bootstrap.globals.command.length >= 4
    ) {
      const native = JSON.parse(
        invokeHost(
          'native-project-commands',
          JSON.stringify({
            action: 'entity-inspect',
            projectRoot: commandResult.envelope.projectRoot,
            collection: bootstrap.globals.command[2],
            id: bootstrap.globals.command[3],
            provenance: bootstrap.globals.command.includes('--provenance'),
          }),
        ),
      ) as { ok?: boolean; error?: string; fields?: unknown };
      validationProfileText +=
        '[native-cli-inspect] ' +
        JSON.stringify({
          native,
          oracle: {
            success: commandResult.envelope.success,
            exitCode: commandResult.exitCode,
            record: commandResult.envelope.record,
            provenance: commandResult.envelope.provenance,
          },
        }) +
        '\n';
    }
    if (
      family === 'entity' &&
      ['create', 'rename', 'delete'].includes(operation) &&
      bootstrap.globals.command.includes('--dry-run') &&
      !invocationContext.prepareResidentSnapshotOnly &&
      environment.NOVELTEA_CLI_CERTIFICATION === '1' &&
      environment.NOVELTEA_CLI_CERTIFICATION_NATIVE_COMMANDS === '1' &&
      typeof commandResult.envelope.projectRoot === 'string' &&
      bootstrap.globals.command.length >= 4
    ) {
      const native = JSON.parse(
        invokeHost(
          'native-project-commands',
          JSON.stringify({
            action: `entity-${operation}`,
            projectRoot: commandResult.envelope.projectRoot,
            collection: bootstrap.globals.command[2],
            id: bootstrap.globals.command[3],
            ...(operation === 'rename' ? { toId: bootstrap.globals.command[4] } : {}),
            dryRun: true,
          }),
        ),
      ) as { ok?: boolean; error?: string; sourcePath?: string; rewrittenSources?: string[] };
      validationProfileText +=
        '[native-cli-entity-edit] ' +
        JSON.stringify({ native, operation, oracle: commandResult.envelope }) +
        '\n';
    }
    if (
      bootstrap.globals.command[0] === 'fmt' &&
      bootstrap.globals.command.includes('--check') &&
      !invocationContext.prepareResidentSnapshotOnly &&
      environment.NOVELTEA_CLI_CERTIFICATION === '1' &&
      environment.NOVELTEA_CLI_CERTIFICATION_NATIVE_COMMANDS === '1' &&
      typeof commandResult.envelope.projectRoot === 'string'
    ) {
      const requestedPath = bootstrap.globals.command[1];
      const native = JSON.parse(
        invokeHost(
          'native-project-commands',
          JSON.stringify({
            action: 'fmt',
            projectRoot: commandResult.envelope.projectRoot,
            ...(requestedPath && !requestedPath.startsWith('--') ? { path: requestedPath } : {}),
            check: true,
            stripDefaults: bootstrap.globals.command.includes('--strip-defaults'),
          }),
        ),
      ) as { ok?: boolean; error?: string; changed?: boolean; files?: string[] };
      validationProfileText += '[native-cli-fmt] ' + JSON.stringify({ native }) + '\n';
    }
    if (
      family === 'localization' &&
      operation === 'sync' &&
      bootstrap.globals.command.includes('--dry-run') &&
      !invocationContext.prepareResidentSnapshotOnly &&
      environment.NOVELTEA_CLI_CERTIFICATION === '1' &&
      environment.NOVELTEA_CLI_CERTIFICATION_NATIVE_COMMANDS === '1' &&
      typeof commandResult.envelope.projectRoot === 'string'
    ) {
      const native = JSON.parse(
        invokeHost(
          'native-project-commands',
          JSON.stringify({
            action: 'localization-sync',
            projectRoot: commandResult.envelope.projectRoot,
            dryRun: true,
          }),
        ),
      ) as { ok?: boolean; error?: string; changed?: boolean };
      validationProfileText +=
        '[native-cli-localization-sync] ' +
        JSON.stringify({
          native,
          oracle: {
            success: commandResult.envelope.success,
            changed: commandResult.envelope.changed,
            materializedMessageIds: commandResult.envelope.materializedMessageIds,
            preservedMessageIds: commandResult.envelope.preservedMessageIds,
            unresolved: commandResult.envelope.unresolved,
            structuredMessageCount: commandResult.envelope.structuredMessageCount,
          },
        }) +
        '\n';
    }
    if (
      family === 'localization' &&
      operation === 'view' &&
      !invocationContext.prepareResidentSnapshotOnly &&
      environment.NOVELTEA_CLI_CERTIFICATION === '1' &&
      environment.NOVELTEA_CLI_CERTIFICATION_NATIVE_COMMANDS === '1' &&
      typeof commandResult.envelope.projectRoot === 'string' &&
      typeof bootstrap.globals.command[2] === 'string' &&
      Array.isArray(commandResult.envelope.messages)
    ) {
      const statusIndex = bootstrap.globals.command.indexOf('--status');
      const native = JSON.parse(
        invokeHost(
          'native-project-commands',
          JSON.stringify({
            action: 'localization-view',
            projectRoot: commandResult.envelope.projectRoot,
            locale: bootstrap.globals.command[2],
            ...(statusIndex < 0 ? {} : { status: bootstrap.globals.command[statusIndex + 1] }),
          }),
        ),
      ) as { ok?: boolean; error?: string; locale?: string; messages?: unknown[] };
      validationProfileText +=
        '[native-cli-localization-view] ' +
        JSON.stringify({
          native,
          oracle: {
            locale: commandResult.envelope.locale,
            statusFilter: commandResult.envelope.statusFilter,
            messages: commandResult.envelope.messages,
          },
        }) +
        '\n';
    }
    if (
      family === 'localization' &&
      operation === 'reconcile' &&
      !bootstrap.globals.command.includes('--apply') &&
      !invocationContext.prepareResidentSnapshotOnly &&
      environment.NOVELTEA_CLI_CERTIFICATION === '1' &&
      environment.NOVELTEA_CLI_CERTIFICATION_NATIVE_COMMANDS === '1' &&
      typeof commandResult.envelope.projectRoot === 'string' &&
      typeof commandResult.envelope.plan === 'object' &&
      commandResult.envelope.plan !== null
    ) {
      const oracle = commandResult.envelope.plan as { expectedWorkspaceRevision: string };
      const native = JSON.parse(
        invokeHost(
          'native-project-commands',
          JSON.stringify({
            action: 'localization-reconcile',
            projectRoot: commandResult.envelope.projectRoot,
            workspaceRevision: oracle.expectedWorkspaceRevision,
            dryRun: true,
          }),
        ),
      ) as { ok?: boolean; error?: string; plan?: unknown };
      validationProfileText +=
        '[native-cli-reconcile] ' + JSON.stringify({ native, oracle }) + '\n';
    }
    // A reproducible certification-only sibling bundle is compared against
    // the public exporter in the installed-headless integration fixture.
    // Both the write and native import occur outside the active Project root.
    if (
      family === 'project' &&
      operation === 'export' &&
      commandResult.envelope.success &&
      environment.NOVELTEA_CLI_CERTIFICATION === '1' &&
      environment.NOVELTEA_CLI_CERTIFICATION_NATIVE_COMMANDS === '1' &&
      typeof commandResult.envelope.projectRoot === 'string' &&
      typeof commandResult.envelope.outputPath === 'string'
    ) {
      const original = commandResult.envelope.outputPath;
      const parsed = path.parse(original);
      const nativeOutput = path.join(parsed.dir, `.${parsed.name}.native-cert.ntproject`);
      const nativeDestination = path.join(parsed.dir, `.${parsed.name}.native-import`);
      const exported = JSON.parse(
        invokeHost(
          'native-project-commands',
          JSON.stringify({
            action: 'project-export',
            projectRoot: commandResult.envelope.projectRoot,
            outputPath: nativeOutput,
          }),
        ),
      ) as { ok?: boolean; error?: string; manifest?: unknown };
      if (!exported.ok)
        throw new Error(exported.error ?? 'Native portable Project export certification failed.');
      const imported = JSON.parse(
        invokeHost(
          'native-project-commands',
          JSON.stringify({
            action: 'project-import',
            bundlePath: nativeOutput,
            destination: nativeDestination,
          }),
        ),
      ) as { ok?: boolean; error?: string; manifest?: unknown };
      if (!imported.ok)
        throw new Error(imported.error ?? 'Native portable Project import certification failed.');
      validationProfileText +=
        '[native-cli-bundle] ' +
        JSON.stringify({ nativeOutput, nativeDestination, exported, imported }) +
        '\n';
    }
    trace('application invocation completed');
    const residentSessionCountAfter = residentWorkspace?.residentSessionCount() ?? 0;
    if (residentSessionCountAfter > residentSessionCountBefore)
      trace(`resident Project session admitted: ${String(residentSessionCountAfter)}`);
    return result(
      commandResult.exitCode,
      commandResult.stdout,
      `${validationProfileText}${commandResult.stderr}`,
    );
  } finally {
    // Report owner admission even when a request fails after opening a Project.
    publishResidentProjectSessionCount();
  }
}
