import type { DialogueLineCue } from './authoring-dialogues';

export interface DialogueCueMarkupDiagnostic {
  offset: number;
  message: string;
}

export interface ParsedDialogueCueMarkup {
  text: string;
  cues: DialogueLineCue[];
  diagnostics: DialogueCueMarkupDiagnostic[];
}

const semanticPrefix = '[nt-cue ';

type SemanticDialogueCue = Exclude<DialogueLineCue, { kind: 'active-text' | 'invalid-markup' }>;

function encodePayload(cue: SemanticDialogueCue): string {
  const { id: _id, kind: _kind, position: _position, ...payload } = cue;
  return encodeURIComponent(JSON.stringify(payload));
}

function semanticToken(cue: SemanticDialogueCue): string {
  return `${semanticPrefix}id=${encodeURIComponent(cue.id)} kind=${cue.kind} data=${encodePayload(cue)}]`;
}

export function serializeDialogueCueMarkup(text: string, cues: readonly DialogueLineCue[]): string {
  const codePoints = Array.from(text);
  const byPosition = new Map<number, DialogueLineCue[]>();
  for (const cue of cues) {
    const list = byPosition.get(cue.position.offset) ?? [];
    list.push(cue);
    byPosition.set(cue.position.offset, list);
  }
  for (const list of byPosition.values())
    list.sort(
      (left, right) =>
        left.position.order - right.position.order || left.id.localeCompare(right.id),
    );

  let result = '';
  for (let offset = 0; offset <= codePoints.length; ++offset) {
    for (const cue of byPosition.get(offset) ?? []) {
      if (cue.kind === 'active-text' || cue.kind === 'invalid-markup') result += cue.token;
      else result += semanticToken(cue);
    }
    if (offset < codePoints.length) result += codePoints[offset];
  }
  return result;
}

function parseSemanticToken(
  token: string,
  position: DialogueLineCue['position'],
): { cue?: DialogueLineCue; message?: string } {
  const body = token.slice(semanticPrefix.length, -1).trim();
  const fields = new Map<string, string>();
  for (const part of body.split(/\s+/u)) {
    const equals = part.indexOf('=');
    if (equals <= 0) return { message: `Malformed semantic cue field '${part}'.` };
    fields.set(part.slice(0, equals), part.slice(equals + 1));
  }
  const encodedId = fields.get('id');
  const kind = fields.get('kind');
  const encodedData = fields.get('data');
  if (!encodedId || !kind || encodedData === undefined)
    return { message: 'Semantic cue requires id, kind, and data fields.' };

  let id: string;
  let payload: unknown;
  try {
    id = decodeURIComponent(encodedId);
    payload = JSON.parse(decodeURIComponent(encodedData));
  } catch {
    return { message: 'Semantic cue contains invalid percent-encoding or JSON data.' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return { message: 'Semantic cue data must decode to an object.' };

  const candidate = { id, kind, position, ...payload };
  if (
    kind !== 'speaker-expression' &&
    kind !== 'stage' &&
    kind !== 'media' &&
    kind !== 'gesture' &&
    kind !== 'voice' &&
    kind !== 'sound-effect' &&
    kind !== 'camera'
  )
    return { message: `Unknown semantic cue kind '${kind}'.` };
  return { cue: candidate as DialogueLineCue };
}

export function parseDialogueCueMarkup(source: string): ParsedDialogueCueMarkup {
  let text = '';
  const cues: DialogueLineCue[] = [];
  const diagnostics: DialogueCueMarkupDiagnostic[] = [];
  let plainOffset = 0;
  let order = 0;

  for (let index = 0; index < source.length;) {
    const codePoint = source.codePointAt(index);
    if (codePoint === undefined) break;
    if (source[index] !== '[') {
      const value = String.fromCodePoint(codePoint);
      text += value;
      index += value.length;
      ++plainOffset;
      order = 0;
      continue;
    }

    const close = source.indexOf(']', index + 1);
    if (close < 0) {
      const message = 'Unclosed Dialogue/ActiveText markup token.';
      diagnostics.push({ offset: plainOffset, message });
      cues.push({
        id: `invalid-${plainOffset}-${order}`,
        kind: 'invalid-markup',
        position: { offset: plainOffset, order },
        token: source.slice(index),
        message,
      });
      break;
    }
    const token = source.slice(index, close + 1);
    const position = { offset: plainOffset, order: order++ };
    if (token.startsWith(semanticPrefix)) {
      const parsed = parseSemanticToken(token, position);
      if (parsed.cue) cues.push(parsed.cue);
      else {
        const message = parsed.message ?? 'Malformed semantic cue.';
        diagnostics.push({ offset: plainOffset, message });
        cues.push({
          id: `invalid-${plainOffset}-${position.order}`,
          kind: 'invalid-markup',
          position,
          token,
          message,
        });
      }
    } else {
      cues.push({
        id: `text-${plainOffset}-${position.order}`,
        kind: 'active-text',
        position,
        token,
      });
    }
    index = close + 1;
  }
  return { text, cues, diagnostics };
}

export function renderActiveTextFromDialogueCues(
  text: string,
  cues: readonly DialogueLineCue[],
): string {
  return serializeDialogueCueMarkup(
    text,
    cues.filter(
      (cue): cue is Extract<DialogueLineCue, { kind: 'active-text' }> => cue.kind === 'active-text',
    ),
  );
}
