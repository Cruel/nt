import { z } from 'zod';
import { EDITOR_IPC_FAILURE, EditorIpcBoundaryError } from '../shared/editor-ipc-boundary';
import {
  imageThumbnailPrewarmRequestSchema,
  imageThumbnailRequestSchema,
  cancelImageThumbnailPrewarmRequestSchema,
} from '../shared/image-thumbnails';
import { COMFYUI_IPC_LIMITS, comfyUiConfigSchema } from '../shared/comfyui';
import type { ComfyUiWorkflowKey } from '../shared/comfyui-workflows';
import { authoringProjectSchema } from '../shared/project-schema/authoring-project';
import { compiledProjectWireV3Schema } from '../shared/project-schema/compiled-project';
import { preparedRuntimeArtifactSchema } from '../shared/project-schema/prepared-runtime-artifact';
import {
  exportCapabilityValues,
  normalizedPlatformDisplayMetadataSchema,
  platformExportProfileSchema,
  playerAccessibilityMetadataSchema,
  playerDisplayMetadataSchema,
  templateCompatibilityRequirementsSchema,
  templateDownloadRequestSchema,
} from '../shared/project-schema/platform-export-contracts';
import { shaderMaterialProjectWireSchema } from '../shared/project-schema/shader-material-project';
import { PROJECT_TEXT_SOURCE_LIMITS } from '../shared/project-text-sources';

const PACKAGED_EDITOR_DOCUMENT = 'noveltea-editor://app/index.html';
const MAX_DIALOG_TITLE_LENGTH = 512;
const MAX_DIALOG_PATH_LENGTH = 32_768;
const MAX_EXTERNAL_URL_LENGTH = 2_048;
const MAX_PROJECT_SESSION_ID_LENGTH = 256;
const MAX_PROJECT_NAME_LENGTH = 512;
const MAX_TEXT_SOURCE_READ_KEY_LENGTH = 1_024;
const MAX_PROJECT_PATH_LENGTH = 32_768;
const MAX_ASSET_OPERATION_PATHS = 10_000;
const MAX_PLAYBACK_TEST_ID_LENGTH = 1_024;
const MAX_PLAYBACK_STEPS = 100_000;
const MAX_SHADER_VARIANTS = 256;
const MAX_SHADER_VARIANT_LENGTH = 256;
const MAX_EXPORT_IDENTIFIER_LENGTH = 512;
const MAX_EXPORT_COLLECTION_ENTRIES = 10_000;
const MAX_EXPORT_ARGUMENTS = 1_024;
const MAX_EXPORT_ARGUMENT_LENGTH = 32_768;
const MAX_COMFYUI_PATH_LENGTH = 32_768;
const sha256DigestSchema = z.custom<`sha256:${string}`>(
  (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value),
);

export interface EditorFrame {
  detached: boolean;
  url: string;
}

export interface EditorWebContents {
  mainFrame: EditorFrame;
  isDestroyed(): boolean;
}

export interface EditorWindow {
  webContents: EditorWebContents;
  isDestroyed(): boolean;
}

export interface EditorIpcEvent {
  sender: EditorWebContents;
  senderFrame: EditorFrame | null;
}

export interface EditorIpcMain {
  handle(
    channel: string,
    handler: (event: EditorIpcEvent, ...arguments_: unknown[]) => unknown,
  ): void;
}

interface EditorOrigin {
  protocol: string;
  hostname: string;
  port: string;
}

export interface EditorDocumentPolicy {
  documentUrl: string;
  origin: EditorOrigin;
}

export interface EditorNavigationPolicyTarget {
  onWillNavigate(listener: (event: EditorNavigationEvent) => void): void;
  onWillRedirect(listener: (event: EditorNavigationEvent) => void): void;
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
}

interface EditorNavigationEvent {
  isMainFrame: boolean;
  url: string;
  preventDefault(): void;
}

function parseEditorUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function editorOrigin(url: URL): EditorOrigin {
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
  };
}

function hasEditorOrigin(value: string, expected: EditorOrigin): boolean {
  const url = parseEditorUrl(value);
  return (
    !!url &&
    url.username === '' &&
    url.password === '' &&
    url.protocol === expected.protocol &&
    url.hostname === expected.hostname &&
    url.port === expected.port
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const unbracketed = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (unbracketed === 'localhost' || unbracketed === '::1') return true;
  const octets = unbracketed.split('.');
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
}

function isTrustedEditorEvent(
  event: EditorIpcEvent,
  owner: EditorWindow | null,
  documentPolicy: EditorDocumentPolicy,
): boolean {
  try {
    if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) return false;
    if (event.sender !== owner.webContents) return false;
    if (!event.senderFrame || event.senderFrame !== owner.webContents.mainFrame) return false;
    if (event.senderFrame.detached) return false;
    return hasEditorOrigin(event.senderFrame.url, documentPolicy.origin);
  } catch {
    return false;
  }
}

export function createEditorDocumentPolicy(developmentUrl?: string): EditorDocumentPolicy {
  const configuredUrl = developmentUrl ?? PACKAGED_EDITOR_DOCUMENT;
  const url = parseEditorUrl(configuredUrl);
  if (!url) throw new Error('Invalid configured editor document URL');
  if (developmentUrl && (url.protocol !== 'http:' || !isLoopbackHostname(url.hostname))) {
    throw new Error('Invalid configured editor development URL');
  }
  if (url.username || url.password || !url.hostname) {
    throw new Error('Invalid configured editor document URL');
  }
  return { documentUrl: url.href, origin: editorOrigin(url) };
}

export function createGuardedIpcRegistrar(options: {
  ipcMain: EditorIpcMain;
  getOwner(): EditorWindow | null;
  documentPolicy: EditorDocumentPolicy;
}) {
  return {
    handle<Arguments extends unknown[], Result>(
      channel: string,
      parseArguments: (arguments_: unknown[]) => Arguments,
      handler: (...arguments_: Arguments) => Result,
    ) {
      options.ipcMain.handle(channel, async (event, ...rawArguments) => {
        if (!isTrustedEditorEvent(event, options.getOwner(), options.documentPolicy)) {
          throw new EditorIpcBoundaryError(EDITOR_IPC_FAILURE.UNTRUSTED_SENDER);
        }

        let parsedArguments: Arguments;
        try {
          parsedArguments = parseArguments(rawArguments);
        } catch {
          throw new EditorIpcBoundaryError(EDITOR_IPC_FAILURE.INVALID_REQUEST);
        }
        return handler(...parsedArguments);
      });
    },
  };
}

export function installEditorNavigationPolicy(
  target: EditorNavigationPolicyTarget,
  documentPolicy: EditorDocumentPolicy,
) {
  const preventUnexpectedDocument = (event: EditorNavigationEvent) => {
    if (!event.isMainFrame) return;
    const targetUrl = parseEditorUrl(event.url);
    if (!targetUrl || targetUrl.href !== documentPolicy.documentUrl) event.preventDefault();
  };
  target.onWillNavigate(preventUnexpectedDocument);
  target.onWillRedirect(preventUnexpectedDocument);
  target.setWindowOpenHandler(() => ({ action: 'deny' }));
}

export const selectDirectoryArgumentsSchema = z.tuple([
  z
    .object({
      title: z.string().min(1).max(MAX_DIALOG_TITLE_LENGTH).optional(),
      defaultPath: z.string().min(1).max(MAX_DIALOG_PATH_LENGTH).nullable().optional(),
    })
    .strict(),
]);

export const noArgumentsSchema = z.tuple([]);

export const selectPackageOutputPathArgumentsSchema = z.tuple([
  z.string().min(1).max(MAX_DIALOG_PATH_LENGTH).nullable(),
]);

export const showItemInFolderArgumentsSchema = z.tuple([
  z.string().min(1).max(MAX_DIALOG_PATH_LENGTH),
]);

export const openExternalArgumentsSchema = z.tuple([
  z
    .string()
    .min(1)
    .max(MAX_EXTERNAL_URL_LENGTH)
    .refine((value) => {
      if (value !== value.trim() || !/^https?:\/\//u.test(value)) return false;
      const url = parseEditorUrl(value);
      return !!url && (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname;
    }),
]);

export const setNativeWindowFrameArgumentsSchema = z.tuple([z.boolean()]);

export const openProjectArgumentsSchema = z.tuple([z.string().min(1).max(MAX_PROJECT_PATH_LENGTH)]);

export const createProjectArgumentsSchema = z.tuple([
  z
    .object({
      projectName: z.string().min(1).max(MAX_PROJECT_NAME_LENGTH),
      projectDirectory: z.string().min(1).max(MAX_PROJECT_PATH_LENGTH),
    })
    .strict(),
]);

export const readProjectTextSourcesArgumentsSchema = z.tuple([
  z
    .object({
      projectSessionId: z.string().min(1).max(MAX_PROJECT_SESSION_ID_LENGTH),
      entries: z
        .array(
          z
            .object({
              readKey: z.string().min(1).max(MAX_TEXT_SOURCE_READ_KEY_LENGTH),
              projectRelativePath: z.string().min(1).max(MAX_PROJECT_PATH_LENGTH),
              expectedContentHash: sha256DigestSchema,
            })
            .strict(),
        )
        .max(PROJECT_TEXT_SOURCE_LIMITS.maxEntries),
    })
    .strict(),
]);

const projectSessionIdSchema = z.string().uuid().max(MAX_PROJECT_SESSION_ID_LENGTH);
const projectRelativePathSchema = z.string().min(1).max(MAX_PROJECT_PATH_LENGTH);

export const importAssetsArgumentsSchema = z.tuple([
  projectSessionIdSchema,
  z.object({ allowMultiple: z.boolean().optional() }).strict(),
]);

export const reimportAssetArgumentsSchema = z.tuple([
  projectSessionIdSchema,
  projectRelativePathSchema,
]);

export const auditProjectAssetsArgumentsSchema = z.tuple([
  projectSessionIdSchema,
  authoringProjectSchema,
]);

export const projectAssetPathsArgumentsSchema = z.tuple([
  projectSessionIdSchema,
  z.array(projectRelativePathSchema).max(MAX_ASSET_OPERATION_PATHS),
]);

export const restoreProjectAssetFilesArgumentsSchema = z.tuple([
  projectSessionIdSchema,
  z
    .array(
      z
        .object({
          projectRelativePath: projectRelativePathSchema,
          trashRelativePath: projectRelativePathSchema,
        })
        .strict(),
    )
    .max(MAX_ASSET_OPERATION_PATHS),
]);

export const projectSessionArgumentsSchema = z.tuple([projectSessionIdSchema]);
export const projectAssetUrlArgumentsSchema = z.tuple([
  projectSessionIdSchema,
  z.string().min(1).max(512),
]);
export const imageThumbnailArgumentsSchema = z.tuple([imageThumbnailRequestSchema]);
export const imageThumbnailPrewarmArgumentsSchema = z.tuple([imageThumbnailPrewarmRequestSchema]);
export const cancelImageThumbnailPrewarmArgumentsSchema = z.tuple([
  cancelImageThumbnailPrewarmRequestSchema,
]);

const playbackSubjectSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('character'),
      id: z.string().min(1).max(MAX_PLAYBACK_TEST_ID_LENGTH),
    })
    .strict(),
  z
    .object({
      kind: z.literal('interactable'),
      id: z.string().min(1).max(MAX_PLAYBACK_TEST_ID_LENGTH),
    })
    .strict(),
]);
const playbackInputSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('advance-time'),
      microseconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z.object({ type: z.literal('continue') }).strict(),
  z
    .object({
      type: z.literal('select-subjects'),
      subjects: z.array(playbackSubjectSchema).max(10_000),
    })
    .strict(),
  z.object({ type: z.literal('clear-selection') }).strict(),
  z
    .object({
      type: z.literal('invoke-interaction'),
      verb: z.string().min(1).max(MAX_PLAYBACK_TEST_ID_LENGTH),
      operands: z.array(playbackSubjectSchema).max(64),
    })
    .strict(),
  z
    .object({
      type: z.literal('activate-hotspot'),
      hotspot: z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('room-hotspot'),
            room: z.string().min(1).max(MAX_PLAYBACK_TEST_ID_LENGTH),
            hotspotId: z.string().min(1).max(MAX_PLAYBACK_TEST_ID_LENGTH),
          })
          .strict(),
        z
          .object({
            kind: z.literal('interactable-hotspot'),
            interactable: z.string().min(1).max(MAX_PLAYBACK_TEST_ID_LENGTH),
            hotspotId: z.string().min(1).max(MAX_PLAYBACK_TEST_ID_LENGTH),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal('load'),
      slot: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('autosave') }).strict(),
        z
          .object({
            kind: z.literal('manual'),
            number: z.number().int().nonnegative().max(0xffff_ffff),
          })
          .strict(),
      ]),
    })
    .strict(),
]);
const playbackSpecSchema = z
  .object({
    schema: z.literal('noveltea.editor.playback'),
    version: z.literal(2),
    id: z.string().min(1).max(MAX_PLAYBACK_TEST_ID_LENGTH),
    steps: z
      .array(
        z.object({ index: z.number().int().nonnegative(), input: playbackInputSchema }).strict(),
      )
      .max(MAX_PLAYBACK_STEPS),
  })
  .strict();

export const validateProjectArgumentsSchema = z.tuple([authoringProjectSchema]);
export const listPlaybackTestsArgumentsSchema = z.tuple([authoringProjectSchema]);
export const runPlaybackTestArgumentsSchema = z.tuple([
  authoringProjectSchema,
  z.string().min(1).max(MAX_PLAYBACK_TEST_ID_LENGTH),
]);
export const runPlaybackSpecArgumentsSchema = z.tuple([
  compiledProjectWireV3Schema,
  playbackSpecSchema,
]);
export const previewSessionArgumentsSchema = z.tuple([projectSessionIdSchema]);
export const previewExportedPackageArgumentsSchema = z.tuple([
  projectSessionIdSchema,
  z.string().min(1).max(MAX_PROJECT_PATH_LENGTH),
]);
export const compileShadersArgumentsSchema = z.tuple([
  projectSessionIdSchema,
  shaderMaterialProjectWireSchema,
  z
    .object({
      forceRebuild: z.boolean().optional(),
      shaderVariants: z
        .array(z.string().min(1).max(MAX_SHADER_VARIANT_LENGTH))
        .max(MAX_SHADER_VARIANTS)
        .optional(),
    })
    .strict(),
]);

const boundedExportStringSchema = z.string().min(1).max(MAX_EXPORT_ARGUMENT_LENGTH);
const boundedExportIdentifierSchema = z.string().min(1).max(MAX_EXPORT_IDENTIFIER_LENGTH);
const boundedExportArgumentsSchema = z
  .array(z.string().max(MAX_EXPORT_ARGUMENT_LENGTH))
  .max(MAX_EXPORT_ARGUMENTS);

export const exportPackageArgumentsSchema = z.tuple([
  projectSessionIdSchema,
  compiledProjectWireV3Schema,
  boundedExportStringSchema,
  preparedRuntimeArtifactSchema.shape.packageOptions,
]);

const platformStageRequestSchema = z
  .object({
    operationId: boundedExportIdentifierSchema,
    profile: platformExportProfileSchema,
    templateToken: boundedExportStringSchema,
    outputDirectory: boundedExportStringSchema,
    packagePath: boundedExportStringSchema,
    iconSourcePath: boundedExportStringSchema.optional(),
    systemAssetsRoot: boundedExportStringSchema.optional(),
    runtimePackageEvidence: z
      .object({
        sourceFingerprint: boundedExportIdentifierSchema,
        packageSha256: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .strict(),
    identity: z
      .object({
        displayName: boundedExportIdentifierSchema,
        shortName: z.string().max(MAX_EXPORT_IDENTIFIER_LENGTH).optional(),
        applicationId: boundedExportIdentifierSchema,
        saveNamespace: boundedExportIdentifierSchema,
        versionName: boundedExportIdentifierSchema,
        defaultLocale: z.string().max(MAX_EXPORT_IDENTIFIER_LENGTH).optional(),
        themeColor: z.string().max(MAX_EXPORT_IDENTIFIER_LENGTH).optional(),
        backgroundColor: z.string().max(MAX_EXPORT_IDENTIFIER_LENGTH).optional(),
        webManifestId: z.string().max(MAX_EXPORT_ARGUMENT_LENGTH).optional(),
        linuxDesktopId: z.string().max(MAX_EXPORT_IDENTIFIER_LENGTH).optional(),
        macosCategory: z.string().max(MAX_EXPORT_IDENTIFIER_LENGTH).optional(),
        macosMicrophoneUsageDescription: z.string().max(MAX_EXPORT_ARGUMENT_LENGTH).optional(),
        androidVersionCode: z.number().int().positive().optional(),
        androidAllowBackup: z.boolean().optional(),
        androidIsGame: z.boolean().optional(),
        localized: z
          .record(
            z.string().min(1).max(MAX_EXPORT_IDENTIFIER_LENGTH),
            z
              .object({
                displayName: z.string().max(MAX_EXPORT_IDENTIFIER_LENGTH).optional(),
                shortName: z.string().max(MAX_EXPORT_IDENTIFIER_LENGTH).optional(),
                description: z.string().max(MAX_EXPORT_ARGUMENT_LENGTH).optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict(),
    display: normalizedPlatformDisplayMetadataSchema,
    runtimeDisplay: playerDisplayMetadataSchema,
    accessibility: playerAccessibilityMetadataSchema,
    capabilities: z
      .array(z.enum(exportCapabilityValues))
      .max(MAX_EXPORT_COLLECTION_ENTRIES)
      .optional(),
    runtimePackageApi: z.number().int().nonnegative(),
    host: z
      .object({
        platform: z.enum(['windows', 'linux', 'macos']),
        availableTools: z.array(boundedExportStringSchema).max(MAX_EXPORT_ARGUMENTS),
      })
      .strict()
      .optional(),
    windowsSigning: z
      .object({
        command: boundedExportStringSchema,
        args: boundedExportArgumentsSchema,
        verifyCommand: boundedExportStringSchema.optional(),
        verifyArgs: boundedExportArgumentsSchema.optional(),
      })
      .strict()
      .optional(),
    linuxAppImageTool: boundedExportStringSchema.optional(),
    macosSigning: z
      .object({
        identity: boundedExportStringSchema,
        entitlementsPath: boundedExportStringSchema.optional(),
      })
      .strict()
      .optional(),
    macosNotarization: z
      .object({ command: boundedExportStringSchema, args: boundedExportArgumentsSchema })
      .strict()
      .optional(),
    macosDmg: z
      .object({ command: boundedExportStringSchema, args: boundedExportArgumentsSchema })
      .strict()
      .optional(),
    androidToolchain: z
      .object({
        androidSdk: boundedExportStringSchema.optional(),
        androidNdk: boundedExportStringSchema.optional(),
        javaHome: boundedExportStringSchema.optional(),
        cmake: boundedExportStringSchema.optional(),
      })
      .strict()
      .optional(),
    androidSigning: z
      .object({
        keystorePath: boundedExportStringSchema,
        keyAlias: boundedExportIdentifierSchema,
        storePassword: z.string().max(MAX_EXPORT_ARGUMENT_LENGTH),
        keyPassword: z.string().max(MAX_EXPORT_ARGUMENT_LENGTH),
      })
      .strict()
      .optional(),
  })
  .strict();

export const stagePlatformExportArgumentsSchema = z.tuple([
  projectSessionIdSchema,
  platformStageRequestSchema,
]);

const projectPlatformExportIpcRequestSchema = z
  .object({
    project: authoringProjectSchema,
    profileId: boundedExportIdentifierSchema,
    outputDirectory: boundedExportStringSchema,
    operationId: boundedExportIdentifierSchema.optional(),
    templateToken: boundedExportStringSchema.optional(),
    checkOnly: z.boolean().optional(),
    force: z.boolean().optional(),
    allowUntrustedTemplate: z.boolean().optional(),
    allowIdentityChange: z.boolean().optional(),
    sign: z.boolean().optional(),
    preparedRuntimeArtifact: preparedRuntimeArtifactSchema.optional(),
    localState: z
      .object({
        androidSdk: boundedExportStringSchema.optional(),
        androidNdk: boundedExportStringSchema.optional(),
        javaHome: boundedExportStringSchema.optional(),
        cmake: boundedExportStringSchema.optional(),
        signing: z
          .object({
            windows: z
              .object({
                command: boundedExportStringSchema,
                args: boundedExportArgumentsSchema,
                verifyCommand: boundedExportStringSchema,
                verifyArgs: boundedExportArgumentsSchema,
              })
              .strict()
              .optional(),
            macos: z
              .object({
                identity: boundedExportStringSchema,
                entitlementsPath: boundedExportStringSchema.optional(),
                notarizationCommand: boundedExportStringSchema.optional(),
                notarizationArgs: boundedExportArgumentsSchema.optional(),
              })
              .strict()
              .optional(),
            android: z
              .object({
                keystorePath: boundedExportStringSchema,
                keyAlias: boundedExportIdentifierSchema,
                storePasswordReference: boundedExportIdentifierSchema,
                keyPasswordReference: boundedExportIdentifierSchema,
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const exportProjectToPlatformArgumentsSchema = z.tuple([
  projectSessionIdSchema,
  projectPlatformExportIpcRequestSchema,
]);
export const cancelPlatformExportArgumentsSchema = z.tuple([
  projectSessionIdSchema,
  boundedExportIdentifierSchema,
]);

export const listPlayerTemplatesArgumentsSchema = z.tuple([
  z
    .object({
      platform: z.enum(['windows', 'linux', 'macos', 'web', 'android']).optional(),
      architecture: boundedExportIdentifierSchema.optional(),
      buildFlavor: z.enum(['debug', 'release']).optional(),
    })
    .strict(),
]);
export const inspectPlayerTemplateArgumentsSchema = z.tuple([
  boundedExportIdentifierSchema,
  boundedExportIdentifierSchema,
]);
export const installPlayerTemplateArgumentsSchema = z.tuple([
  z
    .object({
      archivePath: boundedExportStringSchema,
      force: z.boolean().optional(),
      archiveSha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/u)
        .optional(),
      origin: z.string().max(MAX_EXPORT_ARGUMENT_LENGTH).optional(),
      officialProvenance: z
        .object({
          archiveSha256: z.string().regex(/^[0-9a-f]{64}$/u),
          descriptorSha256: z.string().regex(/^[0-9a-f]{64}$/u),
          source: boundedExportStringSchema,
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
export const downloadPlayerTemplateArgumentsSchema = z.tuple([templateDownloadRequestSchema]);
export const removePlayerTemplateArgumentsSchema = inspectPlayerTemplateArgumentsSchema;
export const resolvePlayerTemplateArgumentsSchema = z.tuple([
  z.object({ requirements: templateCompatibilityRequirementsSchema }).strict(),
]);

const comfyUiSessionSchema = projectSessionIdSchema.nullable();
const comfyUiWorkflowKeySchema = z.custom<ComfyUiWorkflowKey>(
  (value) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= COMFYUI_IPC_LIMITS.workflowIdLength &&
    /^(?:built-in|editor|project):[^\\/]+$/u.test(value),
);
const comfyUiWorkflowIdSchema = z.string().min(1).max(COMFYUI_IPC_LIMITS.workflowIdLength);
const comfyUiPromptSchema = z.string().max(COMFYUI_IPC_LIMITS.promptLength);
const comfyUiGenerationControlsSchema = {
  clientJobId: z.string().min(1).max(COMFYUI_IPC_LIMITS.workflowIdLength).optional(),
  negativePrompt: comfyUiPromptSchema.optional(),
  seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  steps: z.number().int().positive().max(10_000).optional(),
  cfg: z.number().finite().min(0).max(1_000).optional(),
} as const;

export const comfyUiConfigArgumentsSchema = z.tuple([comfyUiConfigSchema]);
export const comfyUiListWorkflowLibraryArgumentsSchema = z.tuple([
  comfyUiSessionSchema,
  z
    .object({
      includeOverridden: z.boolean().optional(),
      comfyUiVersion: z.string().max(COMFYUI_IPC_LIMITS.workflowIdLength).optional(),
    })
    .strict(),
]);
export const comfyUiCopyWorkflowArgumentsSchema = z.tuple([
  comfyUiSessionSchema,
  z
    .object({
      workflowKey: comfyUiWorkflowKeySchema,
      targetSource: z.enum(['editor', 'project']),
      replace: z.boolean().optional(),
    })
    .strict(),
]);
export const comfyUiDeleteWorkflowArgumentsSchema = z.tuple([
  comfyUiSessionSchema,
  z.object({ workflowKey: comfyUiWorkflowKeySchema }).strict(),
]);
export const comfyUiRenameWorkflowArgumentsSchema = z.tuple([
  comfyUiSessionSchema,
  z
    .object({
      workflowKey: comfyUiWorkflowKeySchema,
      label: z.string().min(1).max(COMFYUI_IPC_LIMITS.workflowIdLength),
    })
    .strict(),
]);
export const comfyUiImportWorkflowArgumentsSchema = z.tuple([
  z
    .object({
      workflowFileName: z.string().min(1).max(COMFYUI_IPC_LIMITS.workflowIdLength),
      manifestFileName: z.string().min(1).max(COMFYUI_IPC_LIMITS.workflowIdLength),
      workflowJsonText: z.string().max(COMFYUI_IPC_LIMITS.workflowJsonLength),
      manifest: z.unknown(),
      overwrite: z.boolean(),
      config: comfyUiConfigSchema.optional(),
    })
    .strict(),
]);
export const comfyUiRepairWorkflowArgumentsSchema = z.tuple([
  comfyUiSessionSchema,
  z
    .object({
      workflowKey: comfyUiWorkflowKeySchema,
      manifest: z.unknown(),
      overwrite: z.literal(true),
    })
    .strict(),
]);
export const comfyUiRevealWorkflowArgumentsSchema = z.tuple([
  comfyUiSessionSchema,
  comfyUiWorkflowKeySchema,
]);
export const comfyUiVerifyWorkflowArgumentsSchema = z.tuple([
  comfyUiSessionSchema,
  z.object({ config: comfyUiConfigSchema, force: z.boolean().optional() }).strict(),
]);
export const comfyUiAnalyzeWorkflowArgumentsSchema = z.tuple([
  comfyUiSessionSchema,
  z
    .object({
      workflowJsonText: z.string().max(COMFYUI_IPC_LIMITS.workflowJsonLength),
      config: comfyUiConfigSchema.optional(),
    })
    .strict(),
]);
export const comfyUiGenerateImageArgumentsSchema = z.tuple([
  projectSessionIdSchema,
  comfyUiConfigSchema,
  z
    .object({
      workflowId: comfyUiWorkflowIdSchema.optional(),
      workflowKey: comfyUiWorkflowKeySchema.optional(),
      prompt: comfyUiPromptSchema,
      width: z.number().int().positive().max(16_384).optional(),
      height: z.number().int().positive().max(16_384).optional(),
      ...comfyUiGenerationControlsSchema,
    })
    .strict(),
]);
export const comfyUiEditImageArgumentsSchema = z.tuple([
  projectSessionIdSchema,
  comfyUiConfigSchema,
  z
    .object({
      workflowId: comfyUiWorkflowIdSchema.optional(),
      workflowKey: comfyUiWorkflowKeySchema.optional(),
      sourceAssetId: z.string().min(1).max(COMFYUI_IPC_LIMITS.workflowIdLength).optional(),
      sourceProjectRelativePath: z.string().min(1).max(MAX_COMFYUI_PATH_LENGTH),
      prompt: comfyUiPromptSchema,
      ...comfyUiGenerationControlsSchema,
    })
    .strict(),
]);
export const comfyUiCancelJobArgumentsSchema = z.tuple([
  projectSessionIdSchema,
  comfyUiConfigSchema,
]);
