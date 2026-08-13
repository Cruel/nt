import { z } from 'zod';
import { EDITOR_IPC_FAILURE, EditorIpcBoundaryError } from '../shared/editor-ipc-boundary';
import { PROJECT_TEXT_SOURCE_LIMITS } from '../shared/project-text-sources';

const PACKAGED_EDITOR_DOCUMENT = 'noveltea-editor://app/index.html';
const MAX_DIALOG_TITLE_LENGTH = 512;
const MAX_DIALOG_PATH_LENGTH = 32_768;
const MAX_EXTERNAL_URL_LENGTH = 2_048;
const MAX_PROJECT_SESSION_ID_LENGTH = 256;
const MAX_PROJECT_NAME_LENGTH = 512;
const MAX_TEXT_SOURCE_READ_KEY_LENGTH = 1_024;
const MAX_PROJECT_PATH_LENGTH = 32_768;
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
