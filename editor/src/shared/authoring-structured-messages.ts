import type { AuthoringProject } from './project-schema/authoring-project';
import type { TextContent } from './project-schema/authoring-flow';
import { parseDialogueData } from './project-schema/authoring-dialogues';
import type { DialogueCuePlacement } from './project-schema/authoring-localization';
import {
  resolveArchetypeConfiguration,
  resolveGameplayInstanceRecord,
} from './project-schema/authoring-archetypes';

export interface StructuredMessageOccurrence {
  id: string;
  source: string;
  path: string;
  sourcePath: string | null;
  usageNote: string;
  text?: TextContent;
  dialogueCues?: readonly DialogueCuePlacement[];
}

export interface DialogueMessageCueUsage {
  messageId: string;
  path: string;
  cues: readonly DialogueCuePlacement[];
}

interface StructuredMessageIndex {
  occurrences: readonly StructuredMessageOccurrence[];
  byText: WeakMap<object, StructuredMessageOccurrence>;
  byId: ReadonlyMap<string, StructuredMessageOccurrence>;
  byPath: ReadonlyMap<string, StructuredMessageOccurrence>;
}

const indexCache = new WeakMap<AuthoringProject, StructuredMessageIndex>();

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTextContent(value: unknown): value is TextContent {
  if (!isRecord(value) || (value.markup !== 'plain' && value.markup !== 'active-text'))
    return false;
  const source = value.source;
  if (!isRecord(source) || typeof source.kind !== 'string') return false;
  if (source.kind === 'inline') return typeof source.text === 'string';
  if (source.kind === 'localized') return typeof source.key === 'string';
  if (source.kind === 'lua-expression') return typeof source.source === 'string';
  return false;
}

function fnv1a(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hex(value: number): string {
  return value.toString(16).padStart(8, '0');
}

/**
 * Stable opaque identity for schema-owned structured Messages. The identity is derived only from the
 * semantic owner path, never from prose, so text edits preserve translation history.
 */
export function structuredMessageId(path: string): string {
  const words = [
    fnv1a(path, 0x811c9dc5),
    fnv1a(path, 0x9e3779b9),
    fnv1a(path, 0x85ebca6b),
    fnv1a(path, 0xc2b2ae35),
  ];
  const raw = words.map(hex).join('');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-5${raw.slice(13, 16)}-${((Number.parseInt(raw.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')}${raw.slice(18, 20)}-${raw.slice(20, 32)}`;
}

function semanticArrayToken(value: unknown, index: number): string {
  if (isRecord(value) && typeof value.id === 'string' && value.id.length > 0)
    return `@${escapePointer(value.id)}`;
  return String(index);
}

function buildIndex(project: AuthoringProject): StructuredMessageIndex {
  const occurrences: StructuredMessageOccurrence[] = [];
  const byText = new WeakMap<object, StructuredMessageOccurrence>();
  const byId = new Map<string, StructuredMessageOccurrence>();
  const byPath = new Map<string, StructuredMessageOccurrence>();

  const register = (
    path: string,
    source: string,
    text?: TextContent,
    sourcePath: string | null = text ? `${path}/source/text` : path,
  ): void => {
    const occurrence: StructuredMessageOccurrence = {
      id: project.localization.structuredMessageIds[path] ?? structuredMessageId(path),
      source,
      path,
      sourcePath,
      usageNote: path,
      ...(text ? { text } : {}),
    };
    occurrences.push(occurrence);
    if (text) byText.set(text as object, occurrence);
    byId.set(occurrence.id, occurrence);
    byPath.set(path, occurrence);
  };

  const visit = (value: unknown, path: string, sourceBacked = true): void => {
    if (isTextContent(value)) {
      if (value.source.kind === 'inline')
        register(path, value.source.text, value, sourceBacked ? `${path}/source/text` : null);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) =>
        visit(child, `${path}/${semanticArrayToken(child, index)}`, sourceBacked),
      );
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value))
      visit(child, `${path}/${escapePointer(key)}`, sourceBacked);
  };

  // Only schema-defined gameplay collections and gameplay settings are scanned. Editor metadata,
  // record labels, filenames, IDs, scripts, and generic strings therefore cannot become Messages by
  // shape coincidence.
  const registerTopLevelStrings = (data: unknown, base: string, sourceBacked = true): void => {
    if (!isRecord(data)) return;
    if (typeof data.displayName === 'string')
      register(
        `${base}/displayName`,
        data.displayName,
        undefined,
        sourceBacked ? `${base}/displayName` : null,
      );
    const dialogue = data.dialogue;
    if (isRecord(dialogue) && typeof dialogue.name === 'string')
      register(
        `${base}/dialogue/name`,
        dialogue.name,
        undefined,
        sourceBacked ? `${base}/dialogue/name` : null,
      );
    if (Array.isArray(data.exits)) {
      data.exits.forEach((exit, index) => {
        if (!isRecord(exit) || typeof exit.label !== 'string') return;
        const path = `${base}/exits/${semanticArrayToken(exit, index)}/label`;
        register(path, exit.label, undefined, sourceBacked ? path : null);
      });
    }
  };

  for (const collection of ['characters', 'rooms', 'interactables'] as const) {
    const kind =
      collection === 'characters' ? 'character' : collection === 'rooms' ? 'room' : 'interactable';
    for (const [recordId, record] of Object.entries(project[collection])) {
      const effective = resolveGameplayInstanceRecord(project, kind, record);
      if (!effective) continue;
      const base = `/${collection}/${escapePointer(recordId)}/data`;
      const sourceBacked = !record.archetype;
      registerTopLevelStrings(effective.data, base, sourceBacked);
      visit(effective.data, base, sourceBacked);
    }
  }
  for (const collection of ['dialogues', 'scenes', 'verbs', 'interactions', 'maps'] as const) {
    for (const [recordId, record] of Object.entries(project[collection])) {
      const base = `/${collection}/${escapePointer(recordId)}/data`;
      registerTopLevelStrings(record.data, base);
      visit(record.data, base);
      if (collection === 'dialogues') {
        const dialogue = parseDialogueData(record.data);
        if (!dialogue) continue;
        for (const block of dialogue.blocks) {
          if (block.type !== 'sequence') continue;
          for (const segment of block.segments) {
            if (segment.type !== 'line') continue;
            const textPath = `${base}/blocks/@${escapePointer(block.id)}/segments/@${escapePointer(segment.id)}/text`;
            const occurrence = byPath.get(textPath);
            if (!occurrence) continue;
            const dialogueCues = segment.cues
              .filter((cue) => cue.kind !== 'active-text' && cue.kind !== 'invalid-markup')
              .map((cue) => ({ id: cue.id, position: { ...cue.position } }))
              .sort(
                (left, right) =>
                  left.position.offset - right.position.offset ||
                  left.position.order - right.position.order ||
                  left.id.localeCompare(right.id),
              );
            if (dialogueCues.length > 0) occurrence.dialogueCues = Object.freeze(dialogueCues);
          }
        }
      }
    }
  }
  for (const [archetypeId] of Object.entries(project.archetypes)) {
    const configuration = resolveArchetypeConfiguration(project, archetypeId);
    if (!configuration) continue;
    const base = `/archetypes/${escapePointer(archetypeId)}/configuration`;
    registerTopLevelStrings(configuration.data, base, false);
    visit(configuration.data, base, false);
  }
  register('/settings/titleScreen/subtitle', project.settings.titleScreen.subtitle);
  register('/settings/titleScreen/startLabel', project.settings.titleScreen.startLabel);
  visit(project.undefinedInteractionProgram, '/undefinedInteractionProgram');

  occurrences.sort((left, right) => left.id.localeCompare(right.id));
  return { occurrences, byText, byId, byPath };
}

export function structuredMessages(
  project: AuthoringProject,
): readonly StructuredMessageOccurrence[] {
  let index = indexCache.get(project);
  if (!index) {
    index = buildIndex(project);
    indexCache.set(project, index);
  }
  return index.occurrences;
}

export function structuredMessageForText(
  project: AuthoringProject,
  text: TextContent,
): StructuredMessageOccurrence | null {
  structuredMessages(project);
  return indexCache.get(project)?.byText.get(text as object) ?? null;
}

export function structuredMessageById(
  project: AuthoringProject,
  messageId: string,
): StructuredMessageOccurrence | null {
  structuredMessages(project);
  return indexCache.get(project)?.byId.get(messageId) ?? null;
}

export function structuredMessageForPath(
  project: AuthoringProject,
  path: string,
): StructuredMessageOccurrence | null {
  structuredMessages(project);
  return indexCache.get(project)?.byPath.get(path) ?? null;
}

export function dialogueMessageCueUsages(
  project: AuthoringProject,
): readonly DialogueMessageCueUsage[] {
  structuredMessages(project);
  const namedIds = new Map(
    Object.entries(project.localization.messages).flatMap(([messageId, message]) =>
      message.kind === 'named' ? [[message.key, messageId] as const] : [],
    ),
  );
  const usages: DialogueMessageCueUsage[] = [];
  for (const [dialogueId, record] of Object.entries(project.dialogues)) {
    const dialogue = parseDialogueData(record.data);
    if (!dialogue) continue;
    const base = `/dialogues/${escapePointer(dialogueId)}/data`;
    for (const block of dialogue.blocks) {
      if (block.type !== 'sequence') continue;
      for (const segment of block.segments) {
        if (segment.type !== 'line') continue;
        const path = `${base}/blocks/@${escapePointer(block.id)}/segments/@${escapePointer(segment.id)}/text`;
        const messageId =
          segment.text.source.kind === 'inline'
            ? indexCache.get(project)?.byPath.get(path)?.id
            : segment.text.source.kind === 'localized'
              ? namedIds.get(segment.text.source.key)
              : undefined;
        if (!messageId) continue;
        const cues = Object.freeze(
          segment.cues
            .filter((cue) => cue.kind !== 'active-text' && cue.kind !== 'invalid-markup')
            .map((cue) => ({ id: cue.id, position: { ...cue.position } }))
            .sort(
              (left, right) =>
                left.position.offset - right.position.offset ||
                left.position.order - right.position.order ||
                left.id.localeCompare(right.id),
            ),
        );
        usages.push({ messageId, path, cues });
      }
    }
  }
  return Object.freeze(usages.sort((left, right) => left.path.localeCompare(right.path)));
}

export function dialogueMessageCueContracts(
  project: AuthoringProject,
): ReadonlyMap<string, readonly DialogueCuePlacement[]> {
  const contracts = new Map<string, readonly DialogueCuePlacement[]>();
  for (const usage of dialogueMessageCueUsages(project))
    if (usage.cues.length > 0 && !contracts.has(usage.messageId))
      contracts.set(usage.messageId, usage.cues);
  return contracts;
}

export function resolveStructuredMessageText(
  project: AuthoringProject,
  message: StructuredMessageOccurrence,
  locale: string,
): { text: string; locale: string } {
  const visited = new Set<string>();
  let current: string | null = locale;
  while (current && current !== project.localization.sourceLocale && !visited.has(current)) {
    visited.add(current);
    const translated = project.localization.translations[current]?.[message.id];
    if (translated !== undefined)
      return translated.useSource
        ? { text: message.source, locale: project.localization.sourceLocale }
        : { text: translated.text, locale: current };
    current =
      project.localization.locales[current]?.parentLocale ?? project.localization.sourceLocale;
  }
  return { text: message.source, locale: project.localization.sourceLocale };
}
