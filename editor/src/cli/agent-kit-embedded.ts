import { readFileSync } from 'node:fs';

export interface NovelTeaAgentKitPayload {
  readonly manifestText: string;
  readonly files: Readonly<Record<string, string>>;
}

const PERRY_EMBEDDED_AGENT_KIT_ROOT = '$perryfs/dist/agent-kit';

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export function readPerryEmbeddedAgentKit(): NovelTeaAgentKitPayload {
  const embeddedRoot = PERRY_EMBEDDED_AGENT_KIT_ROOT;
  let manifestText: string;
  try {
    manifestText = readFileSync(`${embeddedRoot}/manifest.json`, 'utf8');
  } catch {
    throw new Error('Embedded NovelTea agent kit is missing from this CLI release.');
  }
  const manifest = JSON.parse(manifestText) as { files?: Record<string, string> };
  if (!manifest.files || typeof manifest.files !== 'object')
    throw new Error('Embedded NovelTea agent-kit manifest is invalid.');
  const files = Object.fromEntries(
    Object.keys(manifest.files)
      .sort(compareCodePoints)
      .map((relativePath) => [
        relativePath,
        readFileSync(`${embeddedRoot}/${relativePath}`, 'utf8'),
      ]),
  );
  return { manifestText, files: Object.freeze(files) };
}
