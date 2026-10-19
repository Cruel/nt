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

/** Physical owner resolution for the generic localization patch contract.
 * This must match ProjectSession::localization_patch_target: the logical
 * AuthoringProject localization tree is not stored in project.yaml. */
export function nativeLocalizationTarget(
  pointer: string,
): { owner: string; relative: string } | null {
  const segments = parseJsonPointer(pointer);
  if (segments[0] !== 'localization' || segments.length < 2) return null;
  const [, field, locale] = segments;
  if (field === 'messages' || field === 'structuredMessageIds')
    return { owner: 'i18n/messages.yaml', relative: buildJsonPointer(segments.slice(1)) };
  if (field === 'usageNotes' || field === 'sourceMessageTracking' || field === 'orphanedMessages') {
    if (segments.length < 3) return null;
    const file =
      field === 'usageNotes'
        ? 'usage-notes'
        : field === 'sourceMessageTracking'
          ? 'tracking'
          : 'orphans';
    return { owner: `i18n/${file}.yaml`, relative: buildJsonPointer(segments.slice(2)) };
  }
  if (field === 'translations' || field === 'assets') {
    if (segments.length < 3 || !locale) return null;
    return {
      owner: `i18n/${field === 'translations' ? 'locales' : 'assets'}/${locale}.yaml`,
      relative: segments.length === 3 ? '/' : buildJsonPointer(segments.slice(3)),
    };
  }
  if (['sourceLocale', 'sourceLocaleLock', 'defaultLocale', 'locales'].includes(field!))
    return { owner: 'i18n/project.yaml', relative: buildJsonPointer(segments.slice(1)) };
  return null;
}

function authoritativeSource(
  acknowledged: NativeAuthoringPatchResult,
  pointer: string,
): { owner: string; pointer: string; source: JsonValue } {
  const segments = parseJsonPointer(pointer);
  const family = segments[0];
  let owner = 'project';
  let relative = pointer;
  if (family === 'localization') {
    const target = nativeLocalizationTarget(pointer);
    if (!target) throw new Error(`Unsupported native localization verification: ${pointer}`);
    owner = target.owner;
    relative = target.relative;
  } else if ((family === 'editor' || family === 'traits') && segments.length > 1) {
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
export function assertNativeProjection(
  proposal: JsonValue,
  patches: readonly JsonPatchOperation[],
  acknowledged: NativeAuthoringPatchResult,
) {
  for (const patch of patches) {
    // JSON Patch's "-" is an append *operation*, not a readable JSON Pointer.
    // Verify the resulting entire parent array instead of attempting to read
    // a nonexistent element named "-" after the native transaction.
    const segments = parseJsonPointer(patch.path);
    // A native root Remove can cancel an unborn record. No record source
    // remains to inspect; require an explicit affected-owner acknowledgment
    // and verify the projected collection no longer contains the ID.
    if (patch.op === 'remove' && segments.length === 2 && recordFamilies.has(segments[0]!)) {
      const owner = `${segments[0]}/${segments[1]}`;
      if (
        acknowledged.affectedRecords.includes(owner) &&
        !acknowledged.snapshot.recordSnapshots?.[owner] &&
        !hasJsonAtPointer(proposal, patch.path)
      )
        continue;
    }
    if (
      patch.op === 'remove' && segments.length === 3 &&
      segments[0] === 'localization' &&
      (segments[1] === 'translations' || segments[1] === 'assets')
    ) {
      const owner = nativeLocalizationTarget(patch.path)?.owner;
      if (owner && acknowledged.affectedRecords.includes(owner) &&
          !acknowledged.snapshot.recordSnapshots?.[owner] &&
          !hasJsonAtPointer(proposal, patch.path)) continue;
    }
    const verifiedPath =
      segments.at(-1) === '-' ? buildJsonPointer(segments.slice(0, -1)) : patch.path;
    const native = authoritativeSource(acknowledged, verifiedPath);
    const locallyPresent = hasJsonAtPointer(proposal, verifiedPath);
    const nativePresent = native.pointer === '/' || hasJsonAtPointer(native.source, native.pointer);
    if (
      locallyPresent !== nativePresent ||
      (locallyPresent &&
        nativePresent &&
        !jsonValuesEqual(
          getJsonAtPointer(proposal, verifiedPath),
          native.pointer === '/' ? native.source : getJsonAtPointer(native.source, native.pointer),
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
