import {
  buildJsonPointer,
  parseJsonPointer,
  getJsonAtPointer,
  hasJsonAtPointer,
} from '@/project/json-pointer';
import { jsonValuesEqual, type JsonValue } from '@/project/json-value';
import type { JsonPatchOperation } from '@/project/json-patch';
import type { NativeAuthoringPatchResult } from '../../main/services/native-authoring-worker-contract';
import type { CommandBusResult, CommandBusState } from './command-bus';

const recordFamilies = new Set([
  'animations',
  'archetypes',
  'assets',
  'characters',
  'dialogues',
  'interactables',
  'interactions',
  'layouts',
  'maps',
  'materials',
  'rooms',
  'scenes',
  'scripts',
  'tests',
  'variables',
  'verbs',
]);

function authoritativeSource(
  acknowledged: NativeAuthoringPatchResult,
  pointer: string,
): { owner: string; pointer: string; source: JsonValue } {
  const segments = parseJsonPointer(pointer);
  const family = segments[0];
  let owner = 'project';
  let relative = pointer;
  if ((family === 'editor' || family === 'traits') && segments.length > 1) {
    owner = family;
    relative = buildJsonPointer(segments.slice(1));
  } else if (family && recordFamilies.has(family) && segments.length >= 2) {
    owner = `${family}/${segments[1]}`;
    relative = buildJsonPointer(segments.slice(2));
  }
  if (!acknowledged.affectedRecords.includes(owner))
    throw new Error(`Native mutation did not acknowledge the affected owner: ${owner}`);
  const candidate =
    owner === 'project'
      ? acknowledged.snapshot.source
      : acknowledged.snapshot.recordSnapshots?.[owner]?.source;
  if (!candidate || typeof candidate !== 'object')
    throw new Error(`Native mutation omitted the affected owner source: ${owner}`);
  return { owner, pointer: relative, source: candidate as JsonValue };
}

/** Native must verify the exact accepted values, not just reply `accepted`.
 * The TypeScript command result is a proposed UI projection, not authority. */
function assertNativeProjection(
  proposal: JsonValue,
  patches: readonly JsonPatchOperation[],
  acknowledged: NativeAuthoringPatchResult,
) {
  for (const patch of patches) {
    // JSON Patch's "-" is an append *operation*, not a readable JSON Pointer.
    // Verify the resulting entire parent array instead of attempting to read
    // a nonexistent element named "-" after the native transaction.
    const segments = parseJsonPointer(patch.path);
    const verifiedPath =
      segments.at(-1) === '-' ? buildJsonPointer(segments.slice(0, -1)) : patch.path;
    const native = authoritativeSource(acknowledged, verifiedPath);
    const locallyPresent = hasJsonAtPointer(proposal, verifiedPath);
    const nativePresent = hasJsonAtPointer(native.source, native.pointer);
    if (
      locallyPresent !== nativePresent ||
      (locallyPresent &&
        nativePresent &&
        !jsonValuesEqual(
          getJsonAtPointer(proposal, verifiedPath),
          getJsonAtPointer(native.source, native.pointer),
        ))
    )
      throw new Error(
        `Native Project mutation disagreed with the proposed UI value: ${patch.path}`,
      );
  }
}

export interface NativeCommandConfirmation {
  result: CommandBusResult;
  workingRevision: number;
}

/** Commit a renderer command, undo or redo only after the native worker has
 * accepted its exact revision-scoped generic patches. Never publish the
 * proposed Project or history while the asynchronous request is in flight. */
export async function confirmNativeCommand(
  original: CommandBusState,
  proposed: CommandBusResult,
  patches: readonly JsonPatchOperation[],
  sessionId: string,
  workingRevision: number,
  submit: (
    sessionId: string,
    revision: number,
    patches: JsonPatchOperation[],
  ) => Promise<NativeAuthoringPatchResult>,
): Promise<NativeCommandConfirmation> {
  if (!proposed.ok || !proposed.projectChanged) return { result: proposed, workingRevision };
  if (!proposed.document || patches.length === 0)
    throw new Error('Changed native command did not provide atomic Project patches.');
  const acknowledged = await submit(sessionId, workingRevision, [...patches]);
  if (!acknowledged.accepted)
    return {
      result: {
        ok: false,
        diagnostics: [
          { severity: 'error', message: acknowledged.error || 'Native mutation rejected.' },
        ],
        projectChanged: false,
        state: original,
      },
      workingRevision,
    };
  if (acknowledged.snapshot.workingRevision <= workingRevision)
    throw new Error('Accepted native mutation did not advance its working revision.');
  assertNativeProjection(proposed.document, patches, acknowledged);
  return { result: proposed, workingRevision: acknowledged.snapshot.workingRevision };
}
