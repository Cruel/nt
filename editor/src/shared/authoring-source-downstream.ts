import { SaxesParser, type SaxesTag } from 'saxes';
import type { AuthoringDependencyGraphDiagnostic } from './authoring-dependency-contracts';
import type {
  EmbeddedLuaSourceKind,
  OwnerNeutralCursorNameOccurrence,
  OwnerNeutralLiteralOccurrence,
} from './project-schema/authoring-lua-analysis';
import { sha256PrefixedUtf8 } from './web-crypto';

export const utf8 = new TextEncoder();
export const sha256 = sha256PrefixedUtf8;

type LiteralToken = Omit<
  OwnerNeutralLiteralOccurrence,
  'sourceUrl' | 'sourceContentHash' | 'sourceKind' | 'regionOrdinal'
>;

function locationAt(source: string, offset: number) {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === '\r') {
      if (source[index + 1] === '\n') index += 1;
      line += 1;
      column = 1;
    } else if (source[index] === '\n') {
      line += 1;
      column = 1;
    } else column += 1;
  }
  return { line, column };
}

function safeCodePoint(value: number): string | null {
  return Number.isInteger(value) &&
    value >= 0 &&
    value <= 0x10ffff &&
    (value < 0xd800 || value > 0xdfff)
    ? String.fromCodePoint(value)
    : null;
}

function isLuaWhitespace(value: string | undefined): boolean {
  return (
    value === ' ' ||
    value === '\f' ||
    value === '\n' ||
    value === '\r' ||
    value === '\t' ||
    value === '\v'
  );
}

function decodeLuaQuoted(raw: string, quote: string): { value: string; complete: boolean } {
  let result = '';
  let complete = true;
  for (let index = 1; index < raw.length - 1; index += 1) {
    const char = raw[index];
    if (char !== '\\') {
      result += char;
      continue;
    }
    const next = raw[++index];
    const simple: Record<string, string> = {
      a: '\x07',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      '\\': '\\',
      "'": "'",
      '"': '"',
    };
    if (next in simple) result += simple[next];
    else if (next === 'z') while (isLuaWhitespace(raw[index + 1])) index += 1;
    else if (next === 'x') {
      const digits = raw.slice(index + 1, index + 3);
      if (/^[0-9a-fA-F]{2}$/.test(digits)) {
        result += String.fromCodePoint(Number.parseInt(digits, 16));
        index += 2;
      } else {
        complete = false;
        result += 'x';
      }
    } else if (next === 'u' && raw[index + 1] === '{') {
      const end = raw.indexOf('}', index + 2);
      const digits = raw.slice(index + 2, end);
      if (end >= 0 && /^[0-9a-fA-F]+$/.test(digits)) {
        const decoded = safeCodePoint(Number.parseInt(digits, 16));
        if (decoded === null) complete = false;
        else result += decoded;
        index = end;
      } else {
        complete = false;
        result += next;
      }
    } else if (/\d/.test(next)) {
      const digits = next + (raw.slice(index + 1).match(/^\d{0,2}/)?.[0] ?? '');
      const decoded = safeCodePoint(Number.parseInt(digits, 10));
      if (decoded === null || Number.parseInt(digits, 10) > 255) complete = false;
      else result += decoded;
      index += digits.length - 1;
    } else if (next === '\n') result += '\n';
    else if (next === '\r') {
      if (raw[index + 1] === '\n') index += 1;
      result += '\n';
    } else {
      complete = false;
      result += next ?? quote;
    }
  }
  return { value: result, complete };
}

type LuaScanToken =
  | { kind: 'identifier'; value: string; start: number; end: number }
  | { kind: 'punctuation'; value: string; start: number; end: number }
  | { kind: 'string'; literal: LiteralToken; start: number; end: number };

function scanLua(source: string): {
  literals: readonly LiteralToken[];
  tokens: readonly LuaScanToken[];
  complete: boolean;
} {
  const literals: LiteralToken[] = [];
  const tokens: LuaScanToken[] = [];
  let complete = true;
  for (let index = 0; index < source.length;) {
    if (source.startsWith('--', index)) {
      const long = source.slice(index + 2).match(/^\[(=*)\[/);
      if (long) {
        const endMarker = `]${long[1]}]`;
        const end = source.indexOf(endMarker, index + 2 + long[0].length);
        if (end < 0) {
          complete = false;
          break;
        }
        index = end + endMarker.length;
        continue;
      }
      let newline = index + 2;
      while (newline < source.length && source[newline] !== '\n' && source[newline] !== '\r')
        newline += 1;
      if (newline >= source.length) index = source.length;
      else if (source[newline] === '\r' && source[newline + 1] === '\n') index = newline + 2;
      else index = newline + 1;
      continue;
    }
    const quote = source[index];
    if (quote === "'" || quote === '"') {
      const start = index;
      index += 1;
      while (index < source.length) {
        const char = source[index++];
        if (char === '\\') {
          if (index >= source.length) {
            complete = false;
            break;
          }
          const escape = source[index++];
          if (escape === 'z') while (isLuaWhitespace(source[index])) index += 1;
          else if (escape === '\r' && source[index] === '\n') index += 1;
          continue;
        }
        if (char === quote) break;
        if (char === '\n' || char === '\r') {
          complete = false;
          break;
        }
      }
      const raw = source.slice(start, index);
      if (!raw.endsWith(quote)) complete = false;
      const location = locationAt(source, start);
      const decoded = decodeLuaQuoted(raw, quote);
      complete &&= decoded.complete;
      const literal: LiteralToken = {
        regionStartUtf16: start,
        regionEndUtf16: index,
        ...location,
        rawLiteral: raw,
        decodedValue: decoded.value,
        literalKind: quote === "'" ? 'single-quoted' : 'double-quoted',
      };
      literals.push(literal);
      tokens.push({ kind: 'string', literal, start, end: index });
      continue;
    }
    if (source[index] === '[') {
      const opening = source.slice(index).match(/^\[(=*)\[/);
      if (opening) {
        const start = index;
        const endMarker = `]${opening[1]}]`;
        const contentStart = index + opening[0].length;
        const end = source.indexOf(endMarker, contentStart);
        if (end < 0) {
          complete = false;
          break;
        }
        const raw = source.slice(start, end + endMarker.length);
        const location = locationAt(source, start);
        let decodedValue = source.slice(contentStart, end);
        if (decodedValue.startsWith('\r\n')) decodedValue = decodedValue.slice(2);
        else if (/^[\r\n]/.test(decodedValue)) decodedValue = decodedValue.slice(1);
        const literal: LiteralToken = {
          regionStartUtf16: start,
          regionEndUtf16: end + endMarker.length,
          ...location,
          rawLiteral: raw,
          decodedValue,
          literalKind: 'long-bracket',
        };
        literals.push(literal);
        tokens.push({
          kind: 'string',
          literal,
          start,
          end: end + endMarker.length,
        });
        index = end + endMarker.length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(source[index])) {
      const start = index;
      index += 1;
      while (/[A-Za-z0-9_]/.test(source[index] ?? '')) index += 1;
      tokens.push({
        kind: 'identifier',
        value: source.slice(start, index),
        start,
        end: index,
      });
      continue;
    }
    if (!isLuaWhitespace(source[index]))
      tokens.push({
        kind: 'punctuation',
        value: source[index],
        start: index,
        end: index + 1,
      });
    index += 1;
  }
  return { literals: Object.freeze(literals), tokens: Object.freeze(tokens), complete };
}

export function lexLuaStringLiterals(source: string): {
  literals: readonly LiteralToken[];
  complete: boolean;
} {
  const scanned = scanLua(source);
  return { literals: scanned.literals, complete: scanned.complete };
}

type RawRegion = {
  kind: EmbeddedLuaSourceKind;
  text: string;
  line: number;
  column: number;
  sourceUrl: string;
  parentRegionOrdinal?: number;
  embeddedDepth: number;
};

function maskRmlRawText(source: string): {
  masked: string;
  scripts: readonly { start: number; end: number; bodyStart: number; bodyEnd: number }[];
  complete: boolean;
} {
  const chars = source.split('');
  const scripts: { start: number; end: number; bodyStart: number; bodyEnd: number }[] = [];
  let cursor = 0;
  let complete = true;
  while (cursor < source.length) {
    const tagStart = source.indexOf('<', cursor);
    if (tagStart < 0) break;
    if (source.startsWith('<!--', tagStart)) {
      const end = source.indexOf('-->', tagStart + 4);
      if (end < 0) {
        complete = false;
        break;
      }
      cursor = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', tagStart)) {
      const end = source.indexOf(']]>', tagStart + 9);
      if (end < 0) {
        complete = false;
        break;
      }
      cursor = end + 3;
      continue;
    }
    if (source.startsWith('<?', tagStart)) {
      const end = source.indexOf('?>', tagStart + 2);
      if (end < 0) {
        complete = false;
        break;
      }
      cursor = end + 2;
      continue;
    }
    if (source.startsWith('<!', tagStart) || source.startsWith('</', tagStart)) {
      const end = source.indexOf('>', tagStart + 2);
      if (end < 0) {
        complete = false;
        break;
      }
      cursor = end + 1;
      continue;
    }
    const nameMatch = source.slice(tagStart + 1).match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/);
    if (!nameMatch) {
      cursor = tagStart + 1;
      continue;
    }
    const tagName = nameMatch[1].toLowerCase();
    let tagEnd = tagStart + 1 + nameMatch[0].length;
    let quote: string | null = null;
    for (; tagEnd < source.length; tagEnd += 1) {
      const c = source[tagEnd];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (tagEnd >= source.length) {
      complete = false;
      break;
    }
    if (/\/\s*>$/.test(source.slice(tagStart, tagEnd + 1))) {
      cursor = tagEnd + 1;
      continue;
    }
    if (tagName !== 'script' && tagName !== 'style') {
      cursor = tagEnd + 1;
      continue;
    }
    const closeRe = new RegExp(`</${tagName}\\s*>`, 'ig');
    closeRe.lastIndex = tagEnd + 1;
    const close = closeRe.exec(source);
    if (!close) {
      complete = false;
      break;
    }
    const bodyStart = tagEnd + 1;
    const bodyEnd = close.index;
    for (let i = bodyStart; i < bodyEnd; i += 1)
      if (chars[i] !== '\r' && chars[i] !== '\n') chars[i] = ' ';
    if (tagName === 'script')
      scripts.push({ start: tagStart, end: closeRe.lastIndex, bodyStart, bodyEnd });
    cursor = closeRe.lastIndex;
  }
  return { masked: chars.join(''), scripts, complete };
}

export function extractRmlRegions(
  text: string,
  sourceUrl: string,
): {
  regions: readonly RawRegion[];
  diagnostics: AuthoringDependencyGraphDiagnostic[];
  complete: boolean;
} {
  const masked = maskRmlRawText(text);
  const regions: RawRegion[] = [];
  const diagnostics: AuthoringDependencyGraphDiagnostic[] = [];
  const parsedScripts: { inline: boolean }[] = [];
  const parser = new SaxesParser({ xmlns: false, position: true });
  parser.on('attribute', (attribute) => {
    const name = attribute.name.toLowerCase();
    if (!/^on[\p{L}_:][\p{L}\p{N}_.:-]*$/u.test(name)) return;
    const closingQuoteOffset = parser.position - 1;
    const quote = text[closingQuoteOffset];
    const openingQuoteOffset =
      quote === '"' || quote === "'" ? text.lastIndexOf(quote, closingQuoteOffset - 1) : -1;
    const location = locationAt(
      text,
      openingQuoteOffset >= 0 ? openingQuoteOffset + 1 : Math.max(0, parser.position),
    );
    regions.push({
      kind: 'rml-event-attribute',
      text: attribute.value,
      ...location,
      sourceUrl,
      embeddedDepth: 0,
    });
  });
  parser.on('opentag', (tag: SaxesTag) => {
    const normalizedAttributes = Object.fromEntries(
      Object.entries(tag.attributes).map(([name, value]) => [
        name.toLowerCase(),
        typeof value === 'string' ? value : value.value,
      ]),
    );
    if (
      tag.name.toLowerCase() === 'script' &&
      !(tag as SaxesTag & { isSelfClosing?: boolean }).isSelfClosing
    )
      parsedScripts.push({ inline: !Object.hasOwn(normalizedAttributes, 'src') });
  });
  parser.on('error', (error) =>
    diagnostics.push({
      severity: 'warning',
      code: 'authoring.lua.rml_parse',
      path: '',
      message: error.message,
      sourceUrl,
      line: parser.line,
      column: parser.column + 1,
    }),
  );
  try {
    parser.write(masked.masked).close();
  } catch {
    /* saxes already reported */
  }
  if (parsedScripts.length !== masked.scripts.length)
    diagnostics.push({
      severity: 'warning',
      code: 'authoring.lua.rml_script_alignment',
      path: '',
      message: 'RML parser and raw-text masker disagreed about script element boundaries.',
    });
  for (const [index, script] of masked.scripts.entries()) {
    if (!parsedScripts[index]?.inline) continue;
    const location = locationAt(text, script.bodyStart);
    regions.push({
      kind: 'rml-inline-script',
      text: text.slice(script.bodyStart, script.bodyEnd),
      ...location,
      sourceUrl,
      embeddedDepth: 0,
    });
  }
  if (!masked.complete)
    diagnostics.push({
      severity: 'warning',
      code: 'authoring.lua.rml_raw_text',
      path: '',
      message: 'Malformed or unterminated RML raw-text element.',
    });
  return {
    regions: Object.freeze(regions),
    diagnostics,
    complete: masked.complete && diagnostics.length === 0,
  };
}

type RmlExternalReference = {
  kind: 'script' | 'template-link' | 'template-use';
  value: string;
};

export function extractRmlExternalReferences(text: string): readonly RmlExternalReference[] {
  const masked = maskRmlRawText(text);
  const references: RmlExternalReference[] = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', (tag: SaxesTag) => {
    const attributes = Object.fromEntries(
      Object.entries(tag.attributes).map(([name, value]) => [
        name.toLowerCase(),
        typeof value === 'string' ? value : value.value,
      ]),
    );
    const name = tag.name.toLowerCase();
    if (name === 'script' && Object.hasOwn(attributes, 'src'))
      references.push({ kind: 'script', value: attributes.src });
    if (
      name === 'link' &&
      attributes.type?.trim().toLowerCase() === 'text/template' &&
      Object.hasOwn(attributes, 'href')
    )
      references.push({ kind: 'template-link', value: attributes.href });
    if (name === 'template' && Object.hasOwn(attributes, 'src'))
      references.push({ kind: 'template-use', value: attributes.src.trim() });
    if (name === 'body' && Object.hasOwn(attributes, 'template'))
      references.push({ kind: 'template-use', value: attributes.template.trim() });
  });
  try {
    parser.write(masked.masked).close();
  } catch {
    // Structural diagnostics are emitted by the main extractor.
  }
  return Object.freeze(references);
}

export function extractTemplateNames(text: string): readonly string[] {
  const masked = maskRmlRawText(text);
  const names: string[] = [];
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', (tag: SaxesTag) => {
    if (tag.name.toLowerCase() !== 'template') return;
    const value = tag.attributes.name;
    const name = typeof value === 'string' ? value : value?.value;
    if (name?.trim()) names.push(name.trim());
  });
  try {
    parser.write(masked.masked).close();
  } catch {
    // Structural diagnostics are emitted by the main extractor.
  }
  return Object.freeze(names);
}

function splitDirectCallArguments(
  tokens: readonly LuaScanToken[],
  openIndex: number,
): readonly (readonly LuaScanToken[])[] | null {
  return directCallArguments(tokens, openIndex)?.args ?? null;
}

export interface ManagedLuaLocalizationDiagnostic {
  code: string;
  message: string;
  line: number;
  column: number;
}

export interface ManagedLuaLocalizationOccurrence {
  kind: 'local' | 'named' | 'plural' | 'select';
  callStartUtf16: number;
  callEndUtf16: number;
  memberStartUtf16: number;
  memberEndUtf16: number;
  line: number;
  column: number;
  sourceLiteral: LiteralToken;
  source: string;
  runtimeArgsStartUtf16?: number;
  runtimeArgsEndUtf16?: number;
  runtimeArgumentNames?: readonly string[];
  selectorStartUtf16?: number;
  selectorEndUtf16?: number;
  casesStartUtf16?: number;
  casesEndUtf16?: number;
  cases?: Readonly<Record<string, string>>;
  metadataStartUtf16?: number;
  metadataEndUtf16?: number;
  context?: string;
  translatorNote?: string;
}

function directCallArguments(
  tokens: readonly LuaScanToken[],
  openIndex: number,
): { args: readonly (readonly LuaScanToken[])[]; closeIndex: number } | null {
  const args: LuaScanToken[][] = [];
  let current: LuaScanToken[] = [];
  let depth = 1;
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === 'punctuation') {
      if (token.value === '(' || token.value === '{' || token.value === '[') depth += 1;
      else if (token.value === ')' || token.value === '}' || token.value === ']') {
        depth -= 1;
        if (depth === 0) {
          args.push(current);
          return { args, closeIndex: index };
        }
      } else if (token.value === ',' && depth === 1) {
        args.push(current);
        current = [];
        continue;
      }
    }
    current.push(token);
  }
  return null;
}

function staticRuntimeArgumentNames(tokens: readonly LuaScanToken[]): readonly string[] | null {
  if (tokens.length === 0) return Object.freeze([]);
  if (tokens.length === 1 && tokens[0]?.kind === 'identifier' && tokens[0].value === 'nil')
    return Object.freeze([]);
  const first = tokens[0];
  const last = tokens.at(-1);
  if (
    first?.kind !== 'punctuation' ||
    first.value !== '{' ||
    last?.kind !== 'punctuation' ||
    last.value !== '}'
  )
    return null;

  const names: string[] = [];
  let index = 1;
  while (index < tokens.length - 1) {
    while (true) {
      const separator = tokens[index];
      if (separator?.kind !== 'punctuation' || (separator.value !== ',' && separator.value !== ';'))
        break;
      index += 1;
    }
    if (index >= tokens.length - 1) break;
    const key = tokens[index];
    const equals = tokens[index + 1];
    if (key?.kind !== 'identifier' || equals?.kind !== 'punctuation' || equals.value !== '=')
      return null;
    names.push(key.value);
    index += 2;
    let depth = 0;
    while (index < tokens.length - 1) {
      const token = tokens[index]!;
      if (token.kind === 'punctuation') {
        if (token.value === '(' || token.value === '{' || token.value === '[') depth += 1;
        else if (token.value === ')' || token.value === '}' || token.value === ']') depth -= 1;
        if (depth === 0 && (token.value === ',' || token.value === ';')) break;
      }
      index += 1;
    }
    if (index < tokens.length - 1) index += 1;
  }
  return Object.freeze(names.sort());
}

function staticMessageCases(
  tokens: readonly LuaScanToken[],
): Readonly<Record<string, LiteralToken>> | null {
  const first = tokens[0];
  const last = tokens.at(-1);
  if (
    first?.kind !== 'punctuation' ||
    first.value !== '{' ||
    last?.kind !== 'punctuation' ||
    last.value !== '}'
  )
    return null;

  const cases: Record<string, LiteralToken> = {};
  let index = 1;
  while (index < tokens.length - 1) {
    while (true) {
      const separator = tokens[index];
      if (separator?.kind !== 'punctuation' || (separator.value !== ',' && separator.value !== ';'))
        break;
      index += 1;
    }
    if (index >= tokens.length - 1) break;

    let key: string | null = null;
    const candidate = tokens[index];
    if (candidate?.kind === 'identifier') {
      key = candidate.value;
      index += 1;
    } else if (candidate?.kind === 'punctuation' && candidate.value === '[') {
      const literalKey = tokens[index + 1];
      const closeBracket = tokens[index + 2];
      if (
        literalKey?.kind !== 'string' ||
        closeBracket?.kind !== 'punctuation' ||
        closeBracket.value !== ']'
      )
        return null;
      key = literalKey.literal.decodedValue;
      index += 3;
    } else return null;

    const equals = tokens[index];
    const value = tokens[index + 1];
    if (
      !key ||
      Object.hasOwn(cases, key) ||
      equals?.kind !== 'punctuation' ||
      equals.value !== '=' ||
      value?.kind !== 'string'
    )
      return null;
    cases[key] = value.literal;
    index += 2;
    if (index < tokens.length - 1) {
      const separator = tokens[index];
      if (separator?.kind !== 'punctuation' || (separator.value !== ',' && separator.value !== ';'))
        return null;
      index += 1;
    }
  }
  return Object.freeze(cases);
}

function staticTranslatorMetadata(
  tokens: readonly LuaScanToken[],
): { context?: string; translatorNote?: string } | null {
  if (tokens.length === 0) return {};
  if (tokens.length === 1 && tokens[0]?.kind === 'identifier' && tokens[0].value === 'nil')
    return {};
  const firstToken = tokens[0];
  const lastToken = tokens.at(-1);
  if (
    firstToken?.kind !== 'punctuation' ||
    firstToken.value !== '{' ||
    lastToken?.kind !== 'punctuation' ||
    lastToken.value !== '}'
  )
    return null;
  const result: { context?: string; translatorNote?: string } = {};
  let index = 1;
  while (index < tokens.length - 1) {
    while (true) {
      const separator = tokens[index];
      if (separator?.kind !== 'punctuation' || (separator.value !== ',' && separator.value !== ';'))
        break;
      index += 1;
    }
    if (index >= tokens.length - 1) break;
    const key = tokens[index];
    const equals = tokens[index + 1];
    const value = tokens[index + 2];
    if (
      key?.kind !== 'identifier' ||
      (key.value !== 'context' && key.value !== 'note') ||
      equals?.kind !== 'punctuation' ||
      equals.value !== '=' ||
      value?.kind !== 'string'
    )
      return null;
    if (key.value === 'context') {
      if (result.context !== undefined) return null;
      result.context = value.literal.decodedValue;
    } else {
      if (result.translatorNote !== undefined) return null;
      result.translatorNote = value.literal.decodedValue;
    }
    index += 3;
    if (index < tokens.length - 1) {
      const separator = tokens[index];
      if (separator?.kind !== 'punctuation' || (separator.value !== ',' && separator.value !== ';'))
        return null;
      index += 1;
    }
  }
  return result;
}

export function analyzeManagedLuaLocalization(source: string): {
  occurrences: readonly ManagedLuaLocalizationOccurrence[];
  diagnostics: readonly ManagedLuaLocalizationDiagnostic[];
} {
  // Every supported managed call begins with the literal Lua identifier
  // Text. Avoid tokenizing unrelated Lua modules for localization discovery.
  if (!source.includes('Text')) return { occurrences: [], diagnostics: [] };
  const tokens = scanLua(source).tokens;
  const occurrences: ManagedLuaLocalizationOccurrence[] = [];
  const diagnostics: ManagedLuaLocalizationDiagnostic[] = [];
  for (let index = 0; index < tokens.length - 3; index += 1) {
    const text = tokens[index];
    const dot = tokens[index + 1];
    const member = tokens[index + 2];
    const open = tokens[index + 3];
    if (
      text?.kind !== 'identifier' ||
      text.value !== 'Text' ||
      dot?.kind !== 'punctuation' ||
      dot.value !== '.' ||
      member?.kind !== 'identifier' ||
      (member.value !== 'tr' &&
        member.value !== 'msg' &&
        member.value !== 'plural' &&
        member.value !== 'select') ||
      open?.kind !== 'punctuation' ||
      open.value !== '('
    )
      continue;
    const previous = tokens[index - 1];
    if (previous?.kind === 'punctuation' && (previous.value === '.' || previous.value === ':'))
      continue;
    const parsed = directCallArguments(tokens, index + 3);
    if (!parsed) continue;
    const location = locationAt(source, text.start);
    const fail = (suffix: string, message: string) =>
      diagnostics.push({
        code: `authoring.localization.lua_${suffix}`,
        message,
        ...location,
      });
    const args = parsed.args;
    const isSelector = member.value === 'plural' || member.value === 'select';
    const expectedMaximum = member.value === 'msg' ? 2 : 3;
    const expectedMinimum = isSelector ? 2 : 1;
    if (args.length < expectedMinimum || args.length > expectedMaximum) {
      fail('arity', `Text.${member.value} has an unsupported argument count.`);
      continue;
    }
    if (isSelector) {
      const selector = args[0] ?? [];
      if (selector.length === 0) {
        fail('selector_missing', `Text.${member.value} requires a selector value.`);
        continue;
      }
      const parsedCases = staticMessageCases(args[1] ?? []);
      if (!parsedCases) {
        fail(
          'cases_static',
          `Text.${member.value} cases must be a literal table with literal string branches.`,
        );
        continue;
      }
      if (!Object.hasOwn(parsedCases, 'other')) {
        fail('cases_other_required', `Text.${member.value} requires an 'other' case.`);
        continue;
      }
      if (
        member.value === 'plural' &&
        Object.keys(parsedCases).some(
          (key) => !['zero', 'one', 'two', 'few', 'many', 'other'].includes(key),
        )
      ) {
        fail(
          'plural_case_invalid',
          'Text.plural cases may only use CLDR zero/one/two/few/many/other categories.',
        );
        continue;
      }
      let metadata: { context?: string; translatorNote?: string } = {};
      if (args.length >= 3) {
        const parsedMetadata = staticTranslatorMetadata(args[2] ?? []);
        if (!parsedMetadata) {
          fail(
            'metadata_static',
            `Text.${member.value} translator metadata must be a literal table containing only literal context/note values.`,
          );
          continue;
        }
        metadata = parsedMetadata;
      }
      const other = parsedCases.other!;
      occurrences.push({
        kind: member.value === 'plural' ? 'plural' : 'select',
        callStartUtf16: text.start,
        callEndUtf16: tokens[parsed.closeIndex]!.end,
        memberStartUtf16: member.start,
        memberEndUtf16: member.end,
        ...location,
        sourceLiteral: other,
        source: other.decodedValue,
        selectorStartUtf16: selector[0]!.start,
        selectorEndUtf16: selector.at(-1)!.end,
        casesStartUtf16: args[1]![0]!.start,
        casesEndUtf16: args[1]!.at(-1)!.end,
        cases: Object.freeze(
          Object.fromEntries(
            Object.entries(parsedCases).map(([key, literal]) => [key, literal.decodedValue]),
          ),
        ),
        runtimeArgumentNames: Object.freeze(['value']),
        ...(args.length >= 3 && (args[2]?.length ?? 0) > 0
          ? {
              metadataStartUtf16: args[2]![0]!.start,
              metadataEndUtf16: args[2]!.at(-1)!.end,
            }
          : {}),
        ...metadata,
      });
      continue;
    }

    const first = args[0];
    if (first?.length !== 1 || first[0]?.kind !== 'string') {
      fail(
        member.value === 'tr' ? 'source_literal' : 'named_key_literal',
        member.value === 'tr'
          ? 'Text.tr requires a direct string literal as its source argument.'
          : 'Text.msg requires a direct string literal named Message key.',
      );
      continue;
    }
    let metadata: { context?: string; translatorNote?: string } = {};
    if (member.value === 'tr' && args.length >= 3) {
      const parsedMetadata = staticTranslatorMetadata(args[2] ?? []);
      if (!parsedMetadata) {
        fail(
          'metadata_static',
          'Text.tr translator metadata must be a literal table containing only literal context/note values.',
        );
        continue;
      }
      metadata = parsedMetadata;
    }
    const runtimeArgs = args.length >= 2 ? args[1] : undefined;
    const hasRuntimeArgs =
      runtimeArgs !== undefined &&
      runtimeArgs.length > 0 &&
      !(
        runtimeArgs.length === 1 &&
        runtimeArgs[0]?.kind === 'identifier' &&
        runtimeArgs[0].value === 'nil'
      );
    occurrences.push({
      kind: member.value === 'tr' ? 'local' : 'named',
      callStartUtf16: text.start,
      callEndUtf16: tokens[parsed.closeIndex]!.end,
      memberStartUtf16: member.start,
      memberEndUtf16: member.end,
      ...location,
      sourceLiteral: first[0].literal,
      source: first[0].literal.decodedValue,
      ...(hasRuntimeArgs
        ? {
            runtimeArgsStartUtf16: runtimeArgs![0]!.start,
            runtimeArgsEndUtf16: runtimeArgs!.at(-1)!.end,
            ...(staticRuntimeArgumentNames(runtimeArgs!) === null
              ? {}
              : { runtimeArgumentNames: staticRuntimeArgumentNames(runtimeArgs!)! }),
          }
        : { runtimeArgumentNames: Object.freeze([]) }),
      ...(member.value === 'tr' && args.length >= 3 && (args[2]?.length ?? 0) > 0
        ? {
            metadataStartUtf16: args[2]![0]!.start,
            metadataEndUtf16: args[2]!.at(-1)!.end,
          }
        : {}),
      ...metadata,
    });
  }
  return { occurrences: Object.freeze(occurrences), diagnostics: Object.freeze(diagnostics) };
}

export function nestedStringRegions(region: RawRegion, parentOrdinal: number): RawRegion[] {
  const result: RawRegion[] = [];
  const tokens = scanLua(region.text).tokens;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const callee = tokens[index];
    const open = tokens[index + 1];
    if (
      callee.kind !== 'identifier' ||
      open.kind !== 'punctuation' ||
      open.value !== '(' ||
      (callee.value !== 'AddEventListener' && callee.value !== 'load')
    )
      continue;
    const previous = tokens[index - 1];
    const isMemberCall =
      previous?.kind === 'punctuation' && (previous.value === ':' || previous.value === '.');
    if (callee.value === 'AddEventListener' ? !isMemberCall : isMemberCall) continue;
    const args = splitDirectCallArguments(tokens, index + 1);
    const argument = args?.[callee.value === 'AddEventListener' ? 1 : 0];
    if (argument?.length !== 1 || argument[0].kind !== 'string') continue;
    const literal = argument[0].literal;
    const line = region.line + literal.line - 1;
    const column = literal.line === 1 ? region.column + literal.column - 1 : literal.column;
    result.push({
      kind: callee.value === 'AddEventListener' ? 'lua-listener-string' : 'lua-load-string',
      text: literal.decodedValue,
      line,
      column,
      sourceUrl: region.sourceUrl,
      parentRegionOrdinal: parentOrdinal,
      embeddedDepth: region.embeddedDepth + 1,
    });
  }
  return result;
}

function sourceLineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - before.lastIndexOf('\n') };
}

export function scanRcssCursorNames(
  source: string,
  sourceUrl: string,
  sourceContentHash: `sha256:${string}`,
  sourceOffset = 0,
  sourceKind: 'rcss' | 'rml-style' | 'rml-style-attribute' = 'rcss',
): OwnerNeutralCursorNameOccurrence[] {
  const masked = source.replace(/\/\*[\s\S]*?\*\//gu, (comment) => ' '.repeat(comment.length));
  const declaration =
    /(?:^|[;{])\s*cursor\s*:\s*([a-z][a-z0-9-]*)(?=\s*(?:!important\s*)?(?:[;}]|$))/giu;
  const occurrences: OwnerNeutralCursorNameOccurrence[] = [];
  for (const match of masked.matchAll(declaration)) {
    const name = match[1];
    if (!name || match.index === undefined) continue;
    const relative = match[0].lastIndexOf(name);
    if (relative < 0) continue;
    const startUtf16 = sourceOffset + match.index + relative;
    const endUtf16 = startUtf16 + name.length;
    const position = sourceLineColumn(
      sourceOffset === 0 ? source : `${' '.repeat(sourceOffset)}${source}`,
      startUtf16,
    );
    occurrences.push({
      sourceUrl,
      sourceContentHash,
      startUtf16,
      endUtf16,
      line: position.line,
      column: position.column,
      name,
      sourceKind,
    });
  }
  return occurrences;
}

export function scanRmlCursorNames(
  source: string,
  sourceUrl: string,
  sourceContentHash: `sha256:${string}`,
): OwnerNeutralCursorNameOccurrence[] {
  const occurrences: OwnerNeutralCursorNameOccurrence[] = [];
  const scanRegion = (
    region: string,
    offset: number,
    sourceKind: 'rml-style' | 'rml-style-attribute',
  ) => {
    const masked = region.replace(/\/\*[\s\S]*?\*\//gu, (comment) => ' '.repeat(comment.length));
    const declaration =
      /(?:^|[;{])\s*cursor\s*:\s*([a-z][a-z0-9-]*)(?=\s*(?:!important\s*)?(?:[;}]|$))/giu;
    for (const match of masked.matchAll(declaration)) {
      const name = match[1];
      if (!name || match.index === undefined) continue;
      const relative = match[0].lastIndexOf(name);
      if (relative < 0) continue;
      const startUtf16 = offset + match.index + relative;
      const endUtf16 = startUtf16 + name.length;
      const position = sourceLineColumn(source, startUtf16);
      occurrences.push({
        sourceUrl,
        sourceContentHash,
        startUtf16,
        endUtf16,
        line: position.line,
        column: position.column,
        name,
        sourceKind,
      });
    }
  };

  const styleElement = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gimu;
  for (const match of source.matchAll(styleElement)) {
    const contents = match[1] ?? '';
    if (!contents || match.index === undefined) continue;
    const relative = match[0].indexOf(contents);
    if (relative >= 0) scanRegion(contents, match.index + relative, 'rml-style');
  }

  const styleAttribute = /\bstyle\s*=\s*(["'])([\s\S]*?)\1/gimu;
  for (const match of source.matchAll(styleAttribute)) {
    const contents = match[2] ?? '';
    if (!contents || match.index === undefined) continue;
    const relative = match[0].indexOf(contents);
    if (relative >= 0) scanRegion(contents, match.index + relative, 'rml-style-attribute');
  }
  return occurrences;
}
