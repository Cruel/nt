import type { LocalizationMessageWorkflowView } from './authoring-localization-workflow';
import type { AuthoringProject } from './project-schema/authoring-project';
import type {
  DialogueCuePlacement,
  LocalizationTranslation,
  MessagePattern,
} from './project-schema/authoring-localization';

/** Editor-local selector value. It is deliberately not a BCP 47 Project locale. */
export const PSEUDO_PREVIEW_LOCALE = '__noveltea_pseudo__';

const accented: Readonly<Record<string, string>> = Object.freeze({
  a: 'áá',
  b: 'ƀ',
  c: 'ç',
  d: 'ď',
  e: 'ëë',
  f: 'ƒ',
  g: 'ğ',
  h: 'ħ',
  i: 'ïï',
  j: 'ĵ',
  k: 'ķ',
  l: 'ľ',
  m: 'ṁ',
  n: 'ñ',
  o: 'öö',
  p: 'þ',
  q: 'ʠ',
  r: 'ř',
  s: 'š',
  t: 'ŧ',
  u: 'üü',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẋ',
  y: 'ÿÿ',
  z: 'ž',
  A: 'ÁÁ',
  B: 'Ƀ',
  C: 'Ç',
  D: 'Ď',
  E: 'ËË',
  F: 'Ƒ',
  G: 'Ğ',
  H: 'Ħ',
  I: 'ÏÏ',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ľ',
  M: 'Ṁ',
  N: 'Ñ',
  O: 'ÖÖ',
  P: 'Þ',
  Q: 'Ɋ',
  R: 'Ř',
  S: 'Š',
  T: 'Ŧ',
  U: 'ÜÜ',
  V: 'Ṽ',
  W: 'Ŵ',
  X: 'Ẋ',
  Y: 'ŸŸ',
  Z: 'Ž',
});

export interface PseudoLocalizedText {
  readonly text: string;
  /** Target code-point boundary for each source code-point boundary. */
  readonly boundaryOffsets: readonly number[];
}

function matchingSpanEnd(
  codePoints: readonly string[],
  start: number,
  close: string,
  closeWidth = 1,
): number | null {
  for (let index = start + 1; index < codePoints.length; index += 1) {
    if (codePoints[index] !== close) continue;
    if (closeWidth === 1 || codePoints[index + 1] === close) return index + closeWidth;
  }
  return null;
}

function protectedSpanEnd(codePoints: readonly string[], start: number): number | null {
  const current = codePoints[start];
  if (current === '{') {
    if (codePoints[start + 1] === '{') return start + 2;
    const end = matchingSpanEnd(codePoints, start, '}');
    if (end === null) return null;
    const name = codePoints.slice(start + 1, end - 1).join('');
    return /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(name) ? end : null;
  }
  if (current === '}' && codePoints[start + 1] === '}') return start + 2;

  if (current === '&') {
    const end = matchingSpanEnd(codePoints, start, ';');
    if (end !== null) {
      const entity = codePoints.slice(start + 1, end - 1).join('');
      if (/^(?:#[0-9]+|#x[0-9a-f]+|[A-Za-z][A-Za-z0-9]+)$/iu.test(entity)) return end;
    }
  }

  if (current === '<') {
    const end = matchingSpanEnd(codePoints, start, '>');
    if (end === null) return null;
    const body = codePoints
      .slice(start + 1, end - 1)
      .join('')
      .trimStart();
    return /^(?:[!?/]|[A-Za-z_])/u.test(body) ? end : null;
  }

  if (current !== '[') return null;
  if (codePoints[start + 1] === '[') {
    for (let index = start + 2; index + 1 < codePoints.length; index += 1)
      if (codePoints[index] === ']' && codePoints[index + 1] === ']') return index + 2;
    return null;
  }
  const end = matchingSpanEnd(codePoints, start, ']');
  if (end === null) return null;
  const body = codePoints
    .slice(start + 1, end - 1)
    .join('')
    .trim();
  return /^(?:\/?[A-Za-z][A-Za-z0-9_-]*(?:[ =].*)?|nt-cue\s)/u.test(body) ? end : null;
}

/**
 * Expands visible Latin text while preserving Message placeholders and authored RML/rich-text tokens.
 * The boundary map lets semantic Dialogue Cue offsets follow the transformed visible text.
 */
export function pseudoLocalizeText(source: string): PseudoLocalizedText {
  const codePoints = Array.from(source);
  const boundaryOffsets = Array.from({ length: codePoints.length + 1 }, () => 0);
  const output: string[] = ['⟦'];
  let outputLength = 1;
  boundaryOffsets[0] = outputLength;

  for (let index = 0; index < codePoints.length;) {
    const protectedEnd = protectedSpanEnd(codePoints, index);
    if (protectedEnd !== null) {
      for (; index < protectedEnd; index += 1) {
        output.push(codePoints[index]!);
        outputLength += 1;
        boundaryOffsets[index + 1] = outputLength;
      }
      continue;
    }

    const transformed = accented[codePoints[index]!] ?? codePoints[index]!;
    output.push(transformed);
    outputLength += Array.from(transformed).length;
    boundaryOffsets[index + 1] = outputLength;
    index += 1;
  }

  output.push('⟧');
  return Object.freeze({
    text: output.join(''),
    boundaryOffsets: Object.freeze(boundaryOffsets),
  });
}

function rmlKey(openTag: string): string | null {
  const match = openTag.match(/\bkey\s*=\s*(["'])(.*?)\1/iu);
  return match?.[2]?.trim() || null;
}

function rmlTagEnd(source: string, start: number): number | null {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return index + 1;
  }
  return null;
}

function nextRmlTag(
  source: string,
  lowerSource: string,
  needle: string,
  from: number,
): number | null {
  let index = lowerSource.indexOf(needle, from);
  while (index >= 0) {
    const boundary = source[index + needle.length];
    if (boundary === undefined || /[\s/>]/u.test(boundary)) return index;
    index = lowerSource.indexOf(needle, index + needle.length);
  }
  return null;
}

/** Materializes authored <nt-tr> source text for standalone focused Layout preview QA. */
export function pseudoLocalizeRmlMessages(project: AuthoringProject, source: string): string {
  const lowerSource = source.toLowerCase();
  const namedSources = new Map(
    Object.values(project.localization.messages).flatMap((message) =>
      message.kind === 'named' ? [[message.key, message.source] as const] : [],
    ),
  );
  let output = '';
  let cursor = 0;
  while (cursor < source.length) {
    const start = nextRmlTag(source, lowerSource, '<nt-tr', cursor);
    if (start === null) break;
    const openEnd = rmlTagEnd(source, start);
    if (openEnd === null) break;
    const openTag = source.slice(start, openEnd);
    output += source.slice(cursor, start);

    if (/\/\s*>$/u.test(openTag)) {
      const key = rmlKey(openTag);
      const messageSource = key ? (namedSources.get(key) ?? null) : null;
      output +=
        messageSource === null
          ? openTag
          : `${openTag.replace(/\/\s*>$/u, '>')}${pseudoLocalizeText(messageSource).text}</nt-tr>`;
      cursor = openEnd;
      continue;
    }

    const closeStart = nextRmlTag(source, lowerSource, '</nt-tr', openEnd);
    if (closeStart === null) {
      output += source.slice(start);
      cursor = source.length;
      break;
    }
    const closeEnd = rmlTagEnd(source, closeStart);
    if (closeEnd === null) {
      output += source.slice(start);
      cursor = source.length;
      break;
    }
    const key = rmlKey(openTag);
    const content = source.slice(openEnd, closeStart);
    const messageSource = key ? (namedSources.get(key) ?? null) : content;
    output +=
      messageSource === null
        ? source.slice(start, closeEnd)
        : `${openTag}${pseudoLocalizeText(messageSource).text}${source.slice(closeStart, closeEnd)}`;
    cursor = closeEnd;
  }
  return output + source.slice(cursor);
}

export function pseudoLocalizePattern(pattern: MessagePattern): MessagePattern {
  if (pattern.kind === 'text') return { kind: 'text', text: pseudoLocalizeText(pattern.text).text };
  return {
    kind: pattern.kind,
    argument: pattern.argument,
    cases: Object.fromEntries(
      Object.entries(pattern.cases).map(([key, branch]) => [key, pseudoLocalizePattern(branch)]),
    ),
  };
}

export function pseudoLocalizeDialogueCues(
  source: string,
  cues: readonly DialogueCuePlacement[],
): readonly DialogueCuePlacement[] {
  const transformed = pseudoLocalizeText(source);
  const sourceLength = transformed.boundaryOffsets.length - 1;
  return Object.freeze(
    cues.map((cue) => ({
      id: cue.id,
      position: {
        offset: transformed.boundaryOffsets[Math.min(cue.position.offset, sourceLength)]!,
        order: cue.position.order,
      },
    })),
  );
}

export function pseudoLocalizationTranslation(
  message: LocalizationMessageWorkflowView,
): LocalizationTranslation {
  const transformed = pseudoLocalizeText(message.source);
  return {
    text: transformed.text,
    ...(message.pattern === undefined ? {} : { pattern: pseudoLocalizePattern(message.pattern) }),
    ...(message.dialogueCues === undefined
      ? {}
      : { dialogueCues: [...pseudoLocalizeDialogueCues(message.source, message.dialogueCues)] }),
    sourceFingerprint: message.sourceFingerprint,
    origin: 'unknown',
    review: 'reviewed',
    acknowledgedPresentationFingerprint: message.presentationFingerprint,
    acknowledgedGuidanceFingerprint: message.guidanceFingerprint,
  };
}

export function pseudoPreviewRuntimeLocale(sourceLocale: string): string {
  const language = sourceLocale.split('-')[0]?.trim().toLowerCase() || 'en';
  return `${language}-x-noveltea-pseudo`;
}
