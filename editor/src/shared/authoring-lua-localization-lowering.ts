import {
  analyzeManagedLuaLocalization,
  collectAuthoringLuaSources,
  type AuthoringLuaSourceDescriptor,
} from './authoring-source-analysis';
import { packageMessageIds } from './authoring-message-lowering';
import { resolveMessage } from './message-resolution';
import { parseJsonPointer } from './json-pointer';
import { cloneAuthoringProject, type AuthoringProject } from './project-schema/authoring-project';
import {
  messagePlaceholderNames,
  type MessagePattern,
} from './project-schema/authoring-localization';
import {
  localizationOwnerKey,
  localizationSourceKey,
  localizationTrackingFingerprint,
  resolveLocalizationSourceIdentity,
  type LocalizationSourceCandidate,
  type LocalizationSourceOccurrenceCandidate,
} from './localization-source-tracking';

export interface ManagedLuaLoweringDiagnostic {
  code: string;
  path: string;
  message: string;
}

type PendingOccurrence = {
  sourcePath: string;
  stableMessageId: string;
  kind: 'local' | 'named' | 'plural' | 'select';
  memberStartUtf16: number;
  memberEndUtf16: number;
  sourceStartUtf16?: number;
  sourceEndUtf16?: number;
  selectorStartUtf16?: number;
  selectorEndUtf16?: number;
  casesEndUtf16?: number;
  metadataStartUtf16?: number;
  metadataEndUtf16?: number;
};

type SourceEdit = {
  startUtf16: number;
  endUtf16: number;
  replacement: string;
};

export interface ManagedLuaLocalizationSource {
  readonly sourceKey: string;
  readonly source: LocalizationSourceCandidate;
  readonly text: string;
  readonly occurrences: readonly ReturnType<
    typeof analyzeManagedLuaLocalization
  >['occurrences'][number][];
}

function normalizeLuaTrackingText(value: string): string {
  return value
    .replace(/--\[(=*)\[[\s\S]*?\]\1\]/gu, '')
    .replace(/--[^\r\n]*/gu, '')
    .replace(/\s+/gu, '');
}

export function collectManagedLuaLocalizationSources(
  project: AuthoringProject,
  sourceDescriptors: readonly AuthoringLuaSourceDescriptor[] = collectAuthoringLuaSources(project),
): readonly ManagedLuaLocalizationSource[] {
  const result: ManagedLuaLocalizationSource[] = [];
  const seenPaths = new Set<string>();
  for (const descriptor of sourceDescriptors) {
    if (descriptor.sourceKind !== 'lua' || descriptor.inlineText === undefined) continue;
    if (seenPaths.has(descriptor.sourcePath)) continue;
    seenPaths.add(descriptor.sourcePath);
    const analyzed = analyzeManagedLuaLocalization(descriptor.inlineText);
    const ownerKey = localizationOwnerKey(descriptor.semanticOwner);
    const occurrenceCandidates: LocalizationSourceOccurrenceCandidate[] = analyzed.occurrences.map(
      (occurrence, ordinal) => {
        const call = descriptor.inlineText!.slice(
          occurrence.callStartUtf16,
          occurrence.callEndUtf16,
        );
        const structuralEdits = [
          {
            start: occurrence.sourceLiteral.regionStartUtf16 - occurrence.callStartUtf16,
            end: occurrence.sourceLiteral.regionEndUtf16 - occurrence.callStartUtf16,
            replacement: '<source>',
          },
          ...(occurrence.metadataStartUtf16 === undefined ||
          occurrence.metadataEndUtf16 === undefined
            ? []
            : [
                {
                  start: occurrence.metadataStartUtf16 - occurrence.callStartUtf16,
                  end: occurrence.metadataEndUtf16 - occurrence.callStartUtf16,
                  replacement: '<metadata>',
                },
              ]),
        ].sort((left, right) => right.start - left.start);
        let structural = call;
        for (const edit of structuralEdits)
          structural = `${structural.slice(0, edit.start)}${edit.replacement}${structural.slice(edit.end)}`;
        const before = descriptor.inlineText!.slice(
          Math.max(0, occurrence.callStartUtf16 - 96),
          occurrence.callStartUtf16,
        );
        const after = descriptor.inlineText!.slice(
          occurrence.callEndUtf16,
          Math.min(descriptor.inlineText!.length, occurrence.callEndUtf16 + 96),
        );
        return {
          ordinal,
          structuralFingerprint: localizationTrackingFingerprint(
            `${occurrence.kind}|${normalizeLuaTrackingText(structural)}`,
          ),
          anchorFingerprint: localizationTrackingFingerprint(
            `${normalizeLuaTrackingText(before)}|<message>|${normalizeLuaTrackingText(after)}`,
          ),
          sourceFingerprint: localizationTrackingFingerprint(occurrence.source),
          sourceSnapshot: occurrence.source,
          ...(occurrence.context === undefined ? {} : { contextSnapshot: occurrence.context }),
          ...(occurrence.translatorNote === undefined
            ? {}
            : { translatorNoteSnapshot: occurrence.translatorNote }),
        };
      },
    );
    const source: LocalizationSourceCandidate = {
      family: 'lua',
      ownerKey,
      sourcePath: descriptor.sourcePath,
      sourceSnapshotFingerprint: localizationTrackingFingerprint(descriptor.inlineText),
      occurrences: Object.freeze(occurrenceCandidates),
    };
    result.push({
      sourceKey: localizationSourceKey('lua', ownerKey, descriptor.sourcePath),
      source,
      text: descriptor.inlineText,
      occurrences: analyzed.occurrences,
    });
  }
  return Object.freeze(result.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)));
}

function valueAtPointer(root: unknown, pointer: string): unknown {
  let current = root;
  for (const segment of parseJsonPointer(pointer)) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function setAtPointer(root: unknown, pointer: string, value: string): boolean {
  const segments = parseJsonPointer(pointer);
  if (segments.length === 0) return false;
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (current === null || typeof current !== 'object') return false;
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') return false;
  (current as Record<string, unknown>)[segments.at(-1)!] = value;
  return true;
}

function preserveRemovedNewlines(original: string, replacement: string): string {
  const missing =
    (original.match(/\r\n|\r|\n/g)?.length ?? 0) - (replacement.match(/\r\n|\r|\n/g)?.length ?? 0);
  return missing > 0 ? `${replacement}${'\n'.repeat(missing)}` : replacement;
}

/**
 * Performs the intentionally narrow authoring-time transform for direct managed Text.tr/Text.msg
 * calls. It never rewrites unrelated Lua and never persists synthetic local Message identities back
 * into the Project; durable free-form source tracking belongs to localization sync.
 */
export function lowerManagedLuaLocalization(project: AuthoringProject): {
  project: AuthoringProject;
  diagnostics: readonly ManagedLuaLoweringDiagnostic[];
  managedSourcePaths: readonly string[];
  managedMessageIds: readonly string[];
} {
  const lowered = cloneAuthoringProject(project);
  const diagnostics: ManagedLuaLoweringDiagnostic[] = [];
  const pending: PendingOccurrence[] = [];
  const seenPaths = new Set<string>();
  const trackingSources = new Map(
    collectManagedLuaLocalizationSources(project).map((source) => [
      source.source.sourcePath,
      source,
    ]),
  );
  const namedMessageIds = new Map<string, string>();
  for (const [messageId, message] of Object.entries(project.localization.messages))
    if (message.kind === 'named') namedMessageIds.set(message.key, messageId);

  for (const descriptor of collectAuthoringLuaSources(project)) {
    if (descriptor.sourceKind !== 'lua' || descriptor.inlineText === undefined) continue;
    if (seenPaths.has(descriptor.sourcePath)) continue;
    const current = valueAtPointer(project, descriptor.sourcePath);
    if (typeof current !== 'string' || current !== descriptor.inlineText) continue;
    seenPaths.add(descriptor.sourcePath);

    const analyzed = analyzeManagedLuaLocalization(current);
    diagnostics.push(
      ...analyzed.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        path: descriptor.sourcePath,
        message: `${diagnostic.message} (${diagnostic.line}:${diagnostic.column})`,
      })),
    );

    analyzed.occurrences.forEach((occurrence, ordinal) => {
      let stableMessageId: string | null = null;
      if (
        occurrence.kind === 'local' ||
        occurrence.kind === 'plural' ||
        occurrence.kind === 'select'
      ) {
        const trackingSource = trackingSources.get(descriptor.sourcePath);
        const trackingOccurrence = trackingSource?.source.occurrences[ordinal];
        if (!trackingSource || !trackingOccurrence) {
          diagnostics.push({
            code: 'authoring.localization.lua_message_tracking_failed',
            path: descriptor.sourcePath,
            message: 'Managed Lua Message could not be assigned source tracking identity.',
          });
          return;
        }
        stableMessageId = resolveLocalizationSourceIdentity(
          project.localization,
          trackingSource.source,
          trackingOccurrence,
        ).messageId;
        if (occurrence.kind === 'plural' || occurrence.kind === 'select') {
          const cases = occurrence.cases ?? {};
          const invalidPlaceholder = Object.entries(cases).find(([, text]) =>
            messagePlaceholderNames(text).some((name) => name !== 'value'),
          );
          if (invalidPlaceholder) {
            diagnostics.push({
              code: 'authoring.localization.lua_selector_placeholder_invalid',
              path: descriptor.sourcePath,
              message: `Text.${occurrence.kind} branches may only interpolate the selector as '{value}'.`,
            });
            return;
          }
          lowered.localization.messages[stableMessageId] = {
            kind: 'local',
            source: occurrence.source,
            arguments: {
              value: occurrence.kind === 'plural' ? 'plural-number' : 'string',
            },
            pattern: {
              kind: occurrence.kind,
              argument: 'value',
              cases: Object.fromEntries(
                Object.entries(cases).map(([key, text]) => [key, { kind: 'text' as const, text }]),
              ),
            },
            ...(occurrence.context === undefined ? {} : { context: occurrence.context }),
            ...(occurrence.translatorNote === undefined
              ? {}
              : { translatorNote: occurrence.translatorNote }),
          };
        } else {
          const placeholderNames = messagePlaceholderNames(occurrence.source);
          if (placeholderNames.length > 0 && occurrence.runtimeArgsStartUtf16 === undefined) {
            diagnostics.push({
              code: 'authoring.localization.lua_message_arguments_missing',
              path: descriptor.sourcePath,
              message: `Text.tr source requires runtime arguments: ${placeholderNames.join(', ')}.`,
            });
            return;
          }
          if (
            occurrence.runtimeArgumentNames !== undefined &&
            occurrence.runtimeArgumentNames.join('\u0000') !== placeholderNames.join('\u0000')
          ) {
            diagnostics.push({
              code: 'authoring.localization.lua_message_arguments_mismatch',
              path: descriptor.sourcePath,
              message: 'Text.tr literal argument table must match the source placeholder names.',
            });
            return;
          }
          lowered.localization.messages[stableMessageId] = {
            kind: 'local',
            source: occurrence.source,
            ...(placeholderNames.length === 0
              ? {}
              : {
                  arguments: Object.fromEntries(
                    placeholderNames.map((name) => [name, 'printable'] as const),
                  ),
                }),
            ...(occurrence.context === undefined ? {} : { context: occurrence.context }),
            ...(occurrence.translatorNote === undefined
              ? {}
              : { translatorNote: occurrence.translatorNote }),
          };
        }
      } else {
        stableMessageId = namedMessageIds.get(occurrence.source) ?? null;
        if (!stableMessageId) {
          diagnostics.push({
            code: 'authoring.localization.lua_named_message_missing',
            path: descriptor.sourcePath,
            message: `Text.msg references unknown named Message '${occurrence.source}'.`,
          });
          return;
        }
        const namedMessage = lowered.localization.messages[stableMessageId];
        if (namedMessage?.kind === 'named') {
          const expectedArgumentNames = Object.keys(namedMessage.arguments ?? {}).sort();
          if (expectedArgumentNames.length > 0 && occurrence.runtimeArgsStartUtf16 === undefined) {
            diagnostics.push({
              code: 'authoring.localization.lua_message_arguments_missing',
              path: descriptor.sourcePath,
              message: `Text.msg('${occurrence.source}') requires runtime Message arguments.`,
            });
            return;
          }
          if (
            occurrence.runtimeArgumentNames !== undefined &&
            occurrence.runtimeArgumentNames.join('\u0000') !== expectedArgumentNames.join('\u0000')
          ) {
            diagnostics.push({
              code: 'authoring.localization.lua_message_arguments_mismatch',
              path: descriptor.sourcePath,
              message: `Text.msg('${occurrence.source}') literal argument table must match its declared Message arguments.`,
            });
            return;
          }
        }
      }
      pending.push({
        sourcePath: descriptor.sourcePath,
        stableMessageId,
        kind: occurrence.kind,
        memberStartUtf16: occurrence.memberStartUtf16,
        memberEndUtf16: occurrence.memberEndUtf16,
        ...(occurrence.kind === 'plural' || occurrence.kind === 'select'
          ? {
              selectorStartUtf16: occurrence.selectorStartUtf16,
              selectorEndUtf16: occurrence.selectorEndUtf16,
              casesEndUtf16: occurrence.casesEndUtf16,
            }
          : {
              sourceStartUtf16: occurrence.sourceLiteral.regionStartUtf16,
              sourceEndUtf16: occurrence.sourceLiteral.regionEndUtf16,
            }),
        ...(occurrence.metadataStartUtf16 === undefined
          ? {}
          : {
              metadataStartUtf16: occurrence.metadataStartUtf16,
              metadataEndUtf16: occurrence.metadataEndUtf16,
            }),
      });
    });
  }

  if (diagnostics.length > 0)
    return {
      project: lowered,
      diagnostics: Object.freeze(diagnostics),
      managedSourcePaths: [],
      managedMessageIds: [],
    };

  const packageIds = packageMessageIds(lowered);
  const byPath = new Map<string, PendingOccurrence[]>();
  for (const occurrence of pending) {
    const list = byPath.get(occurrence.sourcePath) ?? [];
    list.push(occurrence);
    byPath.set(occurrence.sourcePath, list);
  }
  for (const [sourcePath, occurrences] of byPath) {
    const original = valueAtPointer(project, sourcePath);
    if (typeof original !== 'string') continue;
    const edits: SourceEdit[] = [];
    for (const occurrence of occurrences) {
      const id = packageIds.get(occurrence.stableMessageId);
      if (id === undefined) {
        diagnostics.push({
          code: 'authoring.localization.lua_message_lowering_failed',
          path: sourcePath,
          message: 'Managed Lua Message could not be assigned a package-local Message ID.',
        });
        continue;
      }
      edits.push({
        startUtf16: occurrence.memberStartUtf16,
        endUtf16: occurrence.memberEndUtf16,
        replacement: '__message',
      });
      if (occurrence.kind === 'plural' || occurrence.kind === 'select') {
        if (
          occurrence.selectorStartUtf16 === undefined ||
          occurrence.selectorEndUtf16 === undefined ||
          occurrence.casesEndUtf16 === undefined
        ) {
          diagnostics.push({
            code: 'authoring.localization.lua_message_lowering_failed',
            path: sourcePath,
            message: `Text.${occurrence.kind} selector spans were unavailable during lowering.`,
          });
          continue;
        }
        edits.push(
          {
            startUtf16: occurrence.selectorStartUtf16,
            endUtf16: occurrence.selectorStartUtf16,
            replacement: `${id}, { value = `,
          },
          {
            startUtf16: occurrence.selectorEndUtf16,
            endUtf16: occurrence.casesEndUtf16,
            replacement: preserveRemovedNewlines(
              original.slice(occurrence.selectorEndUtf16, occurrence.casesEndUtf16),
              ' }',
            ),
          },
        );
      } else {
        if (occurrence.sourceStartUtf16 === undefined || occurrence.sourceEndUtf16 === undefined) {
          diagnostics.push({
            code: 'authoring.localization.lua_message_lowering_failed',
            path: sourcePath,
            message: 'Managed Lua Message source span was unavailable during lowering.',
          });
          continue;
        }
        edits.push({
          startUtf16: occurrence.sourceStartUtf16,
          endUtf16: occurrence.sourceEndUtf16,
          replacement: preserveRemovedNewlines(
            original.slice(occurrence.sourceStartUtf16, occurrence.sourceEndUtf16),
            String(id),
          ),
        });
      }
      if (occurrence.metadataStartUtf16 !== undefined && occurrence.metadataEndUtf16 !== undefined)
        edits.push({
          startUtf16: occurrence.metadataStartUtf16,
          endUtf16: occurrence.metadataEndUtf16,
          replacement: preserveRemovedNewlines(
            original.slice(occurrence.metadataStartUtf16, occurrence.metadataEndUtf16),
            'nil',
          ),
        });
    }
    let source = original;
    let previousStart = original.length + 1;
    for (const edit of edits.sort((left, right) => right.startUtf16 - left.startUtf16)) {
      if (edit.endUtf16 > previousStart) {
        diagnostics.push({
          code: 'authoring.localization.lua_overlapping_lowering',
          path: sourcePath,
          message: 'Managed Lua Message lowering produced overlapping source edits.',
        });
        continue;
      }
      source = `${source.slice(0, edit.startUtf16)}${edit.replacement}${source.slice(edit.endUtf16)}`;
      previousStart = edit.startUtf16;
    }
    setAtPointer(lowered, sourcePath, source);
  }

  return {
    project: lowered,
    diagnostics: Object.freeze(diagnostics),
    managedSourcePaths: Object.freeze([...byPath.keys()].sort()),
    managedMessageIds: Object.freeze(
      [...new Set(pending.map((item) => item.stableMessageId))].sort(),
    ),
  };
}

function luaQuotedString(value: string): string {
  let result = '"';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === '\\' || character === '"') result += `\\${character}`;
    else if (character === '\n') result += '\\n';
    else if (character === '\r') result += '\\r';
    else if (character === '\t') result += '\\t';
    else if (code < 0x20 || code === 0x7f) result += `\\${code.toString().padStart(3, '0')}`;
    else result += character;
  }
  return `${result}"`;
}

function luaMessagePattern(pattern: MessagePattern): string {
  if (pattern.kind === 'text') return `{kind="text",text=${luaQuotedString(pattern.text)}}`;
  const cases = Object.entries(pattern.cases)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, branch]) => `[${luaQuotedString(key)}]=${luaMessagePattern(branch)}`)
    .join(',');
  return `{kind=${luaQuotedString(pattern.kind)},argument=${luaQuotedString(pattern.argument)},cases={${cases}}}`;
}

function focusedPreviewMessagePattern(
  project: AuthoringProject,
  messageId: string,
  resolvedLocale: string,
): MessagePattern | undefined {
  const source = project.localization.messages[messageId];
  if (!source) return undefined;
  if (resolvedLocale === project.localization.sourceLocale) return source.pattern;
  return project.localization.translations[resolvedLocale]?.[messageId]?.pattern;
}

/**
 * Focused preview executes authored Lua without a Compiled Project catalog. Reuse the production
 * lowering, then install a tiny per-source realization table for only the lowered Message IDs.
 */
export function lowerManagedLuaLocalizationForFocusedPreview(project: AuthoringProject): {
  project: AuthoringProject;
  diagnostics: readonly ManagedLuaLoweringDiagnostic[];
} {
  const lowered = lowerManagedLuaLocalization(project);
  if (lowered.diagnostics.length > 0 || lowered.managedSourcePaths.length === 0)
    return { project: lowered.project, diagnostics: lowered.diagnostics };

  const ids = packageMessageIds(lowered.project);
  const entries: string[] = [];
  for (const messageId of lowered.managedMessageIds) {
    const packageId = ids.get(messageId);
    const message = lowered.project.localization.messages[messageId];
    if (packageId === undefined || !message) continue;
    const resolved = resolveMessage(lowered.project.localization, {
      messageId,
      locale: lowered.project.localization.defaultLocale,
    }).resolved;
    const text = resolved?.text ?? message.source;
    const pattern = focusedPreviewMessagePattern(
      lowered.project,
      messageId,
      resolved?.locale ?? lowered.project.localization.sourceLocale,
    );
    entries.push(
      `[${packageId}]={text=${luaQuotedString(text)}${pattern ? `,pattern=${luaMessagePattern(pattern)}` : ''}}`,
    );
  }
  const language = lowered.project.localization.defaultLocale.split('-')[0]!.toLowerCase();
  const prelude =
    `local __noveltea_messages={${entries.join(',')}};local __noveltea_lang=${luaQuotedString(language)};` +
    'local function __noveltea_plural(v)local n=math.abs(tonumber(v) or 0);local i=math.floor(n);local int=n==i;local m10=i%10;local m100=i%100;local l=__noveltea_lang;' +
    "if l=='zh' or l=='ja' or l=='ko' or l=='th' or l=='vi' or l=='id' or l=='ms' then return 'other' end;" +
    "if l=='ar' then if n==0 then return 'zero' elseif n==1 then return 'one' elseif n==2 then return 'two' elseif n%100>=3 and n%100<=10 then return 'few' elseif n%100>=11 and n%100<=99 then return 'many' else return 'other' end end;" +
    "if l=='ru' or l=='uk' or l=='be' then if not int then return 'other' elseif m10==1 and m100~=11 then return 'one' elseif m10>=2 and m10<=4 and (m100<12 or m100>14) then return 'few' else return 'many' end end;" +
    "if l=='pl' then if not int then return 'other' elseif i==1 then return 'one' elseif m10>=2 and m10<=4 and (m100<12 or m100>14) then return 'few' else return 'many' end end;" +
    "if l=='cs' or l=='sk' then if not int then return 'many' elseif i==1 then return 'one' elseif i>=2 and i<=4 then return 'few' else return 'other' end end;" +
    "if l=='sl' then if not int then return 'few' elseif m100==1 then return 'one' elseif m100==2 then return 'two' elseif m100==3 or m100==4 then return 'few' else return 'other' end end;" +
    "if l=='lt' then if not int then return 'many' elseif m10==1 and (m100<11 or m100>19) then return 'one' elseif m10>=2 and m10<=9 and (m100<11 or m100>19) then return 'few' else return 'other' end end;" +
    "if l=='ro' then if int and i==1 then return 'one' elseif not int or n==0 or (m100>=2 and m100<=19) then return 'few' else return 'other' end end;" +
    "if l=='he' then if int and i==1 then return 'one' elseif int and i==2 then return 'two' else return 'other' end end;" +
    "if l=='fr' or l=='pt' then return int and (i==0 or i==1) and 'one' or 'other' end;return int and i==1 and 'one' or 'other' end;" +
    "local function __noveltea_interp(text,args)local a=text:gsub('{{','\\1'):gsub('}}','\\2');a=a:gsub('{([%a_][%w_-]*)}',function(k)local v=args[k];if v==nil then error('Managed Message argument is missing: '..k) end;return tostring(v) end);return a:gsub('\\1','{'):gsub('\\2','}') end;" +
    "local function __noveltea_realize(node,args)while node.kind~='text' do local v=args[node.argument];if v==nil then error('Managed Message selector argument is missing: '..node.argument) end;local key=node.kind=='plural' and __noveltea_plural(v) or tostring(v);node=node.cases[key] or node.cases.other;if node==nil then error('Managed Message selector has no fallback') end end;return __noveltea_interp(node.text,args) end;" +
    'local __noveltea_Text=Text;local Text=setmetatable({},{__index=__noveltea_Text});' +
    'Text.__message=function(id,args)local message=__noveltea_messages[id];' +
    "if message==nil then error('Managed Message could not be realized') end;args=args or {};return message.pattern and __noveltea_realize(message.pattern,args) or __noveltea_interp(message.text,args) end;";
  for (const sourcePath of lowered.managedSourcePaths) {
    const source = valueAtPointer(lowered.project, sourcePath);
    if (typeof source === 'string')
      setAtPointer(lowered.project, sourcePath, `${prelude}${source}`);
  }
  return { project: lowered.project, diagnostics: lowered.diagnostics };
}
