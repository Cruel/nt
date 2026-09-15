import { SaxesParser, type SaxesTag } from 'saxes';
import type {
  AuthoringDependencyContributionKey,
  AuthoringDependencyGraphDiagnostic,
  AuthoringDependencyNodeKey,
} from './authoring-dependency-contracts';
import { buildJsonPointer, escapeJsonPointerSegment, parseJsonPointer } from './json-pointer';
import {
  AUTHORING_SOURCE_ANALYZER_VERSION,
  LUA_REFERENCE_ANALYSIS_LIMITS,
  type AuthoringCursorNameOccurrence,
  type AuthoringLiteralOccurrence,
  type AuthoringSourceAnalysisArtifact,
  type AuthoringSourceContentArtifact,
  type EmbeddedLuaSourceKind,
  type EmbeddedLuaSourceRegion,
  type LuaSourceSnapshot,
  type OwnerNeutralCursorNameOccurrence,
  type OwnerNeutralEmbeddedLuaSourceRegion,
  type OwnerNeutralLiteralOccurrence,
  type OwnerNeutralManagedLuaMessageOccurrence,
  type OwnerNeutralSourceDiagnostic,
} from './project-schema/authoring-lua-analysis';
import type { AuthoringProject } from './project-schema/authoring-project';
import {
  authoringCollectionKeys,
  type AuthoringCollectionKey,
} from './project-schema/authoring-collections';
import { parseLayoutData } from './project-schema/authoring-layouts';
import { parseScriptModuleData } from './project-schema/authoring-script-modules';
import { parseRoomData } from './project-schema/authoring-rooms';
import { parseSceneData } from './project-schema/authoring-scenes';
import { parseDialogueData } from './project-schema/authoring-dialogues';
import { parseVerbData } from './project-schema/authoring-verbs';
import { parseInteractionData } from './project-schema/authoring-interactions';
import { parseMapData } from './project-schema/authoring-maps';
import { parseTestData } from './project-schema/authoring-tests';
import {
  collectRegisteredAuthoringLuaSources,
  isRegisteredLuaExplicitFallbackOwner,
  type AuthoringLuaExecutionSurface,
  type RegisteredAuthoringLuaSource,
} from './project-schema/authoring-lua-source-registry';
import { sha256PrefixedUtf8 } from './web-crypto';
import {
  authoringAssetPath as assetPath,
  declaredLayoutDependencyByResolvedPath,
  resolveLayoutProjectUri,
} from './layout-source-resolution';
import { inlineLayoutSourceUrl } from './project-schema/layout-source-url';

const utf8 = new TextEncoder();
const sha256 = sha256PrefixedUtf8;

export type AuthoringLuaSourceDescriptor = {
  executionSurface: AuthoringLuaExecutionSurface;
  contributionKey: AuthoringDependencyContributionKey;
  semanticOwner: AuthoringDependencyNodeKey;
  sourcePath: string;
  sourceKind: 'lua' | 'rml' | 'rcss';
  sourceUrl: string;
  inlineText?: string;
  sourceAssetId?: string;
  focusedAdmission: boolean;
  focusedFacet?: 'preview-visual' | 'preview-ui';
  supportsExplicitFallback: boolean;
  explicitDependenciesPath?: string;
  explicitDependencies?: readonly unknown[];
  layoutId?: string;
  dependencyScriptIds?: readonly string[];
  dependencyTemplateIds?: readonly string[];
};

export interface AuthoringSourceAnalysisCache {
  contentArtifacts: Map<string, AuthoringSourceContentArtifact>;
  ownerProjections: Map<
    string,
    AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>
  >;
}

export function createAuthoringSourceAnalysisCache(): AuthoringSourceAnalysisCache {
  return { contentArtifacts: new Map(), ownerProjections: new Map() };
}

const recordKey = (collection: AuthoringCollectionKey, id: string): AuthoringDependencyNodeKey => ({
  kind: 'record',
  collection,
  id,
});
const recordContributionKey = (collection: AuthoringCollectionKey, id: string) =>
  `record:${JSON.stringify(['record', collection, id])}`;

const schemaParsers = {
  rooms: parseRoomData,
  scenes: parseSceneData,
  dialogues: parseDialogueData,
  verbs: parseVerbData,
  interactions: parseInteractionData,
  maps: parseMapData,
  tests: parseTestData,
} as const;

function sourceDescriptorFromScript(
  project: AuthoringProject,
  scriptId: string,
  owner: AuthoringDependencyNodeKey,
  contributionKey: string,
  sourcePath: string,
  ownerBasePath: readonly string[],
  registered: RegisteredAuthoringLuaSource,
): AuthoringLuaSourceDescriptor | null {
  const parsed = parseScriptModuleData(project.scripts[scriptId]?.data);
  if (!parsed) return null;
  const sourceAssetId = parsed.source.kind === 'asset' ? parsed.source.asset.$ref.id : undefined;
  const assetSourcePath = sourceAssetId ? assetPath(project, sourceAssetId) : null;
  return {
    executionSurface: registered.surface,
    contributionKey,
    semanticOwner: owner,
    sourcePath,
    sourceKind: 'lua',
    sourceUrl:
      parsed.source.kind === 'inline-lua'
        ? 'authoring:inline-lua'
        : assetSourcePath
          ? `project:/${assetSourcePath}`
          : 'project:/__missing_source.lua',
    inlineText: parsed.source.kind === 'inline-lua' ? parsed.source.source : undefined,
    sourceAssetId,
    focusedAdmission: registered.focusedAdmission,
    focusedFacet: registered.focusedFacet,
    supportsExplicitFallback: registered.supportsExplicitFallback,
    explicitDependenciesPath: registered.explicitDependenciesPath
      ? buildJsonPointer([...ownerBasePath, ...registered.explicitDependenciesPath])
      : undefined,
    explicitDependencies: registered.explicitDependencies,
  };
}

export function collectAuthoringLuaSources(
  project: AuthoringProject,
  contributionKeys?: ReadonlySet<AuthoringDependencyContributionKey>,
): readonly AuthoringLuaSourceDescriptor[] {
  const output: AuthoringLuaSourceDescriptor[] = [];
  const includesContribution = (key: string) =>
    contributionKeys === undefined || contributionKeys.has(key);
  for (const [id, record] of Object.entries(project.scripts).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const contributionKey = recordContributionKey('scripts', id);
    if (!includesContribution(contributionKey)) continue;
    const parsed = parseScriptModuleData(record.data);
    if (!parsed) continue;
    const base = `/scripts/${escapeJsonPointerSegment(id)}/data/source`;
    const sourceAssetId = parsed.source.kind === 'asset' ? parsed.source.asset.$ref.id : undefined;
    const sourceAssetPath = sourceAssetId ? assetPath(project, sourceAssetId) : null;
    output.push({
      executionSurface: 'script-record',
      contributionKey,
      semanticOwner: recordKey('scripts', id),
      sourcePath: parsed.source.kind === 'inline-lua' ? `${base}/source` : `${base}/asset/$ref`,
      sourceKind: 'lua',
      sourceUrl:
        parsed.source.kind === 'inline-lua'
          ? 'authoring:inline-lua'
          : sourceAssetPath
            ? `project:/${sourceAssetPath}`
            : 'project:/__missing_source.lua',
      inlineText: parsed.source.kind === 'inline-lua' ? parsed.source.source : undefined,
      sourceAssetId,
      focusedAdmission: false,
      supportsExplicitFallback: false,
    });
  }
  for (const [id, record] of Object.entries(project.layouts).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const contributionKey = recordContributionKey('layouts', id);
    if (!includesContribution(contributionKey)) continue;
    const parsed = parseLayoutData(record.data);
    if (!parsed) continue;
    const owner = recordKey('layouts', id);
    for (const [name, sourceKind] of [
      ['lua', 'lua'],
      ['rml', 'rml'],
      ['rcss', 'rcss'],
    ] as const) {
      const source = parsed[name];
      const base = `/layouts/${escapeJsonPointerSegment(id)}/data/${name}`;
      const sourceAssetId = source.sourceMode === 'asset' ? source.sourceAsset?.$ref.id : undefined;
      const sourceAssetPath = sourceAssetId ? assetPath(project, sourceAssetId) : null;
      output.push({
        executionSurface: name === 'lua' ? 'layout-dedicated-lua' : 'layout-rml',
        contributionKey,
        semanticOwner: owner,
        sourcePath:
          source.sourceMode === 'inline' ? `${base}/sourceText` : `${base}/sourceAsset/$ref`,
        sourceKind,
        sourceUrl:
          source.sourceMode === 'inline'
            ? sourceKind === 'rml'
              ? inlineLayoutSourceUrl(id)
              : sourceKind === 'rcss'
                ? 'authoring:inline-rcss'
                : 'authoring:inline-lua'
            : sourceAssetPath
              ? `project:/${sourceAssetPath}`
              : sourceKind === 'rml'
                ? 'project:/__missing_layout.rml'
                : sourceKind === 'rcss'
                  ? 'project:/__missing_layout.rcss'
                  : 'project:/__missing_layout.lua',
        inlineText: source.sourceMode === 'inline' ? source.sourceText : undefined,
        sourceAssetId,
        focusedAdmission: name === 'rml' || (name === 'lua' && parsed.script.enabled),
        focusedFacet: 'preview-ui',
        supportsExplicitFallback:
          name === 'rml' && isRegisteredLuaExplicitFallbackOwner(['layouts', id, 'data', 'script']),
        explicitDependenciesPath:
          name === 'rml'
            ? `/layouts/${escapeJsonPointerSegment(id)}/data/script/additionalDependencies`
            : undefined,
        explicitDependencies:
          name === 'rml' ? parsed.script.additionalDependencies?.targets : undefined,
        layoutId: id,
        dependencyScriptIds: parsed.dependencies.scripts.map((ref) => ref.$ref.id),
        dependencyTemplateIds: (parsed.dependencies.templates ?? []).map((ref) => ref.$ref.id),
      });
    }
  }
  for (const collection of Object.keys(schemaParsers) as (keyof typeof schemaParsers)[]) {
    for (const [id, record] of Object.entries(project[collection]).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const contributionKey = recordContributionKey(collection, id);
      if (!includesContribution(contributionKey)) continue;
      const parsed = schemaParsers[collection](record.data) as unknown;
      if (!parsed) continue;
      const baseSegments = [collection, id, 'data'];
      const owner = recordKey(collection, id);
      for (const registered of collectRegisteredAuthoringLuaSources(collection, parsed)) {
        const absoluteSourcePath = buildJsonPointer([...baseSegments, ...registered.sourcePath]);
        if (registered.scriptRecordId) {
          const descriptor = sourceDescriptorFromScript(
            project,
            registered.scriptRecordId,
            owner,
            contributionKey,
            absoluteSourcePath,
            baseSegments,
            registered,
          );
          if (descriptor) output.push(descriptor);
          continue;
        }
        output.push({
          executionSurface: registered.surface,
          contributionKey,
          semanticOwner: owner,
          sourcePath: absoluteSourcePath,
          sourceKind: 'lua',
          sourceUrl: 'authoring:inline-lua',
          inlineText: registered.sourceText,
          focusedAdmission: registered.focusedAdmission,
          focusedFacet: registered.focusedFacet,
          supportsExplicitFallback: registered.supportsExplicitFallback,
          explicitDependenciesPath: registered.explicitDependenciesPath
            ? buildJsonPointer([...baseSegments, ...registered.explicitDependenciesPath])
            : undefined,
          explicitDependencies: registered.explicitDependencies,
        });
      }
    }
  }
  return Object.freeze(
    output.sort(
      (a, b) =>
        a.contributionKey.localeCompare(b.contributionKey) ||
        a.sourcePath.localeCompare(b.sourcePath),
    ),
  );
}

export function classifyAuthoringLuaSourceOwner(
  project: AuthoringProject,
  sourcePath: string,
): AuthoringLuaSourceDescriptor | null {
  return (
    collectAuthoringLuaSources(project).find((source) => source.sourcePath === sourcePath) ?? null
  );
}

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

function extractRmlRegions(
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

function extractRmlExternalReferences(text: string): readonly RmlExternalReference[] {
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

function extractTemplateNames(text: string): readonly string[] {
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

function nestedStringRegions(region: RawRegion, parentOrdinal: number): RawRegion[] {
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

function scanRcssCursorNames(
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

function scanRmlCursorNames(
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

export async function analyzeAuthoringSourceContent(input: {
  sourceUrl: string;
  text: string;
  kind: 'lua' | 'rml' | 'rcss';
  contentHash?: `sha256:${string}`;
  limits?: {
    maxSourceBytes: number;
    maxEmbeddedListenerDepth: number;
  };
}): Promise<AuthoringSourceContentArtifact> {
  const contentHash = input.contentHash ?? (await sha256(input.text));
  const limits = input.limits ?? LUA_REFERENCE_ANALYSIS_LIMITS;
  const fingerprint = await sha256(
    JSON.stringify([AUTHORING_SOURCE_ANALYZER_VERSION, input.kind, input.sourceUrl, contentHash]),
  );
  if (utf8.encode(input.text).byteLength > limits.maxSourceBytes)
    return {
      analyzerVersion: AUTHORING_SOURCE_ANALYZER_VERSION,
      sourceContentFingerprint: fingerprint,
      regions: [],
      literalOccurrences: [],
      cursorNameOccurrences: [],
      managedMessageOccurrences: [],
      diagnostics: [
        {
          code: 'authoring.lua.source_limit',
          severity: 'warning',
          message: 'Source exceeds the fixed analysis byte limit.',
          sourceUrl: input.sourceUrl,
        },
      ],
      complete: false,
    };
  const extracted =
    input.kind === 'rml'
      ? extractRmlRegions(input.text, input.sourceUrl)
      : input.kind === 'lua'
        ? {
            regions: [
              {
                kind: 'lua-field' as const,
                text: input.text,
                line: 1,
                column: 1,
                sourceUrl: input.sourceUrl,
                embeddedDepth: 0,
              },
            ],
            diagnostics: [],
            complete: true,
          }
        : { regions: [], diagnostics: [], complete: true };
  const rawRegions = [...extracted.regions];
  for (let index = 0; index < rawRegions.length; index += 1) {
    const region = rawRegions[index];
    if (region.embeddedDepth >= limits.maxEmbeddedListenerDepth) continue;
    rawRegions.push(...nestedStringRegions(region, index));
  }
  const regions: OwnerNeutralEmbeddedLuaSourceRegion[] = [];
  const literals: OwnerNeutralLiteralOccurrence[] = [];
  const managedMessages: OwnerNeutralManagedLuaMessageOccurrence[] = [];
  const cursorNameOccurrences =
    input.kind === 'rml'
      ? scanRmlCursorNames(input.text, input.sourceUrl, contentHash)
      : input.kind === 'rcss'
        ? scanRcssCursorNames(input.text, input.sourceUrl, contentHash)
        : [];
  let complete = extracted.complete;
  const diagnostics: OwnerNeutralSourceDiagnostic[] = extracted.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    sourceUrl: input.sourceUrl,
  }));
  rawRegions.forEach((region, regionOrdinal) => {
    regions.push({
      sourceUrl: region.sourceUrl,
      sourceKind: region.kind,
      containerContentHash: contentHash,
      regionOrdinal,
      parentRegionOrdinal: region.parentRegionOrdinal,
      containerLine: region.line,
      containerColumn: region.column,
      decodedSource: region.text,
    });
    const lexed = lexLuaStringLiterals(region.text);
    complete &&= lexed.complete;
    if (!lexed.complete)
      diagnostics.push({
        code: 'authoring.lua.lexical_incomplete',
        severity: 'warning',
        message: 'Lua source contains an unterminated or unsupported lexical construct.',
        sourceUrl: input.sourceUrl,
        regionOrdinal,
        line: region.line,
        column: region.column,
      });
    for (const literal of lexed.literals)
      literals.push({
        ...literal,
        line: region.line + literal.line - 1,
        column: literal.line === 1 ? region.column + literal.column - 1 : literal.column,
        sourceUrl: region.sourceUrl,
        sourceContentHash: contentHash,
        regionOrdinal,
        sourceKind: region.kind,
      });
    const managed = analyzeManagedLuaLocalization(region.text);
    for (const diagnostic of managed.diagnostics)
      diagnostics.push({
        code: diagnostic.code,
        severity: 'error',
        message: diagnostic.message,
        sourceUrl: region.sourceUrl,
        regionOrdinal,
        line: region.line + diagnostic.line - 1,
        column: diagnostic.line === 1 ? region.column + diagnostic.column - 1 : diagnostic.column,
      });
    for (const occurrence of managed.occurrences) {
      const literal = occurrence.sourceLiteral;
      managedMessages.push({
        ...occurrence,
        line: region.line + occurrence.line - 1,
        column: occurrence.line === 1 ? region.column + occurrence.column - 1 : occurrence.column,
        sourceUrl: region.sourceUrl,
        sourceContentHash: contentHash,
        regionOrdinal,
        sourceLiteral: {
          ...literal,
          line: region.line + literal.line - 1,
          column: literal.line === 1 ? region.column + literal.column - 1 : literal.column,
          sourceUrl: region.sourceUrl,
          sourceContentHash: contentHash,
          regionOrdinal,
          sourceKind: region.kind,
        },
      });
    }
  });
  return {
    analyzerVersion: AUTHORING_SOURCE_ANALYZER_VERSION,
    sourceContentFingerprint: fingerprint,
    regions: Object.freeze(regions),
    literalOccurrences: Object.freeze(literals),
    cursorNameOccurrences: Object.freeze(cursorNameOccurrences),
    managedMessageOccurrences: Object.freeze(managedMessages),
    diagnostics: Object.freeze(diagnostics),
    complete,
  };
}

export async function bindAuthoringSourceOwner(
  descriptor: AuthoringLuaSourceDescriptor,
  artifacts: readonly AuthoringSourceContentArtifact[],
): Promise<AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>> {
  const regions: EmbeddedLuaSourceRegion[] = [];
  const literals: AuthoringLiteralOccurrence[] = [];
  const managedMessages: import('./project-schema/authoring-lua-analysis').AuthoringManagedLuaMessageOccurrence[] =
    [];
  const cursorNameOccurrences: AuthoringCursorNameOccurrence[] = [];
  const diagnostics: AuthoringDependencyGraphDiagnostic[] = [];
  for (const artifact of artifacts) {
    regions.push(
      ...artifact.regions.map((region) => ({
        ...region,
        semanticOwner: descriptor.semanticOwner,
        sourcePath: descriptor.sourcePath,
        sourceAssetId: descriptor.sourceAssetId,
      })),
    );
    literals.push(
      ...artifact.literalOccurrences.map((literal) => ({
        ...literal,
        sourcePath: descriptor.sourcePath,
        sourceAssetId: descriptor.sourceAssetId,
      })),
    );
    cursorNameOccurrences.push(
      ...artifact.cursorNameOccurrences.map((occurrence) => ({
        ...occurrence,
        sourcePath: descriptor.sourcePath,
        sourceAssetId: descriptor.sourceAssetId,
      })),
    );
    managedMessages.push(
      ...artifact.managedMessageOccurrences.map((occurrence) => ({
        ...occurrence,
        sourcePath: descriptor.sourcePath,
        sourceAssetId: descriptor.sourceAssetId,
        sourceLiteral: {
          ...occurrence.sourceLiteral,
          sourcePath: descriptor.sourcePath,
          sourceAssetId: descriptor.sourceAssetId,
        },
      })),
    );
    diagnostics.push(
      ...artifact.diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        code: diagnostic.code,
        path: descriptor.sourcePath,
        message: diagnostic.message,
        sourceUrl: diagnostic.sourceUrl,
        ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
        ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
      })),
    );
  }
  return {
    semanticOwnerKey: descriptor.contributionKey,
    analyzerVersion: AUTHORING_SOURCE_ANALYZER_VERSION,
    sourceContentFingerprints: artifacts.map((artifact) => artifact.sourceContentFingerprint),
    ownerProjectionFingerprint: await sha256(
      JSON.stringify([
        AUTHORING_SOURCE_ANALYZER_VERSION,
        descriptor.executionSurface,
        descriptor.contributionKey,
        descriptor.sourcePath,
        descriptor.sourceAssetId ?? null,
        artifacts.map((artifact) => artifact.sourceContentFingerprint),
      ]),
    ),
    sourceAssetIds: descriptor.sourceAssetId ? [descriptor.sourceAssetId] : [],
    regions: Object.freeze(regions),
    literalOccurrences: Object.freeze(literals),
    cursorNameOccurrences: Object.freeze(cursorNameOccurrences),
    managedMessageOccurrences: Object.freeze(managedMessages),
    diagnostics: Object.freeze(diagnostics),
    complete: artifacts.every((artifact) => artifact.complete),
  };
}

export function collectAuthoringSourceRequirements(
  project: AuthoringProject,
  contributionKey?: AuthoringDependencyContributionKey,
): readonly string[] {
  const ids = new Set<string>();
  for (const descriptor of collectAuthoringLuaSources(project))
    if (
      descriptor.sourceAssetId &&
      (contributionKey === undefined || descriptor.contributionKey === contributionKey)
    )
      ids.add(descriptor.sourceAssetId);
  for (const [id, record] of Object.entries(project.layouts)) {
    if (contributionKey !== undefined && recordContributionKey('layouts', id) !== contributionKey)
      continue;
    const layout = parseLayoutData(record.data);
    if (!layout) continue;
    for (const ref of [...layout.dependencies.scripts, ...(layout.dependencies.templates ?? [])])
      ids.add(ref.$ref.id);
  }
  return Object.freeze([...ids].sort());
}

export async function analyzeAuthoringSources(
  project: AuthoringProject,
  snapshot: LuaSourceSnapshot,
  limits: {
    [K in keyof typeof LUA_REFERENCE_ANALYSIS_LIMITS]: number;
  } = LUA_REFERENCE_ANALYSIS_LIMITS,
  contributionKeys?: ReadonlySet<AuthoringDependencyContributionKey>,
  persistentCache?: AuthoringSourceAnalysisCache,
  sourceDescriptors?: readonly AuthoringLuaSourceDescriptor[],
): Promise<
  ReadonlyMap<
    string,
    readonly AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[]
  >
> {
  let bytes = 0;
  let occurrences = 0;
  let byteBudgetExhausted = false;
  let occurrenceBudgetExhausted = false;
  const output = new Map<
    string,
    AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[]
  >();
  const cache =
    persistentCache?.contentArtifacts ?? new Map<string, AuthoringSourceContentArtifact>();
  const countedPhysicalSources = new Set<string>();
  const blockedOwners = new Set<string>();
  const ownerOccurrenceCounts = new Map<string, number>();
  const descriptors = sourceDescriptors ?? collectAuthoringLuaSources(project, contributionKeys);

  const diagnosticContentArtifact = async (
    descriptor: AuthoringLuaSourceDescriptor,
    code: string,
    message: string,
    sourceUrl = descriptor.sourceUrl,
  ): Promise<AuthoringSourceContentArtifact> => ({
    analyzerVersion: AUTHORING_SOURCE_ANALYZER_VERSION,
    sourceContentFingerprint: await sha256(
      JSON.stringify([AUTHORING_SOURCE_ANALYZER_VERSION, code, sourceUrl]),
    ),
    regions: [],
    literalOccurrences: [],
    cursorNameOccurrences: [],
    managedMessageOccurrences: [],
    diagnostics: [{ code, severity: 'warning', message, sourceUrl }],
    complete: false,
  });

  const appendDiagnostic = async (
    descriptor: AuthoringLuaSourceDescriptor,
    code: string,
    message: string,
    sourceUrl = descriptor.sourceUrl,
  ) => {
    if (blockedOwners.has(descriptor.contributionKey)) return;
    const list = output.get(descriptor.contributionKey) ?? [];
    list.push(
      await bindAuthoringSourceOwner(descriptor, [
        await diagnosticContentArtifact(descriptor, code, message, sourceUrl),
      ]),
    );
    output.set(descriptor.contributionKey, list);
  };

  const blockOwner = async (
    descriptor: AuthoringLuaSourceDescriptor,
    code: string,
    message: string,
  ) => {
    if (blockedOwners.has(descriptor.contributionKey)) return;
    const prior = output.get(descriptor.contributionKey) ?? [];
    const priorOccurrences = prior.reduce(
      (sum, analysis) =>
        sum + analysis.literalOccurrences.length + analysis.cursorNameOccurrences.length,
      0,
    );
    occurrences -= priorOccurrences;
    ownerOccurrenceCounts.delete(descriptor.contributionKey);
    output.set(descriptor.contributionKey, [
      await bindAuthoringSourceOwner(descriptor, [
        await diagnosticContentArtifact(descriptor, code, message),
      ]),
    ]);
    blockedOwners.add(descriptor.contributionKey);
  };

  const addBound = async (
    descriptor: AuthoringLuaSourceDescriptor,
    artifact: AuthoringSourceContentArtifact,
  ) => {
    if (blockedOwners.has(descriptor.contributionKey)) return false;
    const candidate = await bindAuthoringSourceOwner(descriptor, [artifact]);
    const bound =
      persistentCache?.ownerProjections.get(candidate.ownerProjectionFingerprint) ?? candidate;
    persistentCache?.ownerProjections.set(candidate.ownerProjectionFingerprint, bound);
    const list = output.get(descriptor.contributionKey) ?? [];
    const currentOccurrences = ownerOccurrenceCounts.get(descriptor.contributionKey) ?? 0;
    const boundOccurrences = bound.literalOccurrences.length + bound.cursorNameOccurrences.length;
    if (currentOccurrences + boundOccurrences > limits.maxLiteralOccurrencesPerSemanticOwner) {
      await blockOwner(
        descriptor,
        'authoring.lua.owner_occurrence_limit',
        'Semantic owner exceeds the fixed literal-occurrence analysis limit.',
      );
      return false;
    }
    if (
      occurrenceBudgetExhausted ||
      occurrences + boundOccurrences > limits.maxSnapshotLiteralOccurrences
    ) {
      occurrenceBudgetExhausted = true;
      await blockOwner(
        descriptor,
        'authoring.lua.snapshot_occurrence_limit',
        'Complete source snapshot exceeded the fixed literal-occurrence limit.',
      );
      return false;
    }
    list.push(bound);
    occurrences += boundOccurrences;
    ownerOccurrenceCounts.set(descriptor.contributionKey, currentOccurrences + boundOccurrences);
    output.set(descriptor.contributionKey, list);
    return true;
  };

  const countSourceBytes = async (
    descriptor: AuthoringLuaSourceDescriptor,
    text: string,
    physicalKey: string,
  ) => {
    if (countedPhysicalSources.has(physicalKey)) return true;
    const sourceBytes = utf8.encode(text).byteLength;
    if (byteBudgetExhausted || bytes + sourceBytes > limits.maxSnapshotBytes) {
      byteBudgetExhausted = true;
      await blockOwner(
        descriptor,
        'authoring.lua.snapshot_byte_limit',
        'Complete source snapshot exceeded the fixed source-byte limit.',
      );
      return false;
    }
    countedPhysicalSources.add(physicalKey);
    bytes += sourceBytes;
    return true;
  };

  const artifactFor = async (
    sourceUrl: string,
    text: string,
    kind: 'lua' | 'rml' | 'rcss',
    hash?: `sha256:${string}`,
  ) => {
    const key = JSON.stringify([
      AUTHORING_SOURCE_ANALYZER_VERSION,
      kind,
      sourceUrl,
      hash ?? (await sha256(text)),
    ]);
    let artifact = cache.get(key);
    if (!artifact) {
      artifact = await analyzeAuthoringSourceContent({
        sourceUrl,
        text,
        kind,
        contentHash: hash,
        limits,
      });
      cache.set(key, artifact);
    }
    return artifact;
  };

  for (const descriptor of descriptors) {
    if (blockedOwners.has(descriptor.contributionKey)) continue;
    let text: string | undefined = descriptor.inlineText;
    let hash: `sha256:${string}` | undefined;
    let physicalKey = `inline:${descriptor.contributionKey}:${descriptor.sourcePath}`;
    if (descriptor.sourceAssetId) {
      const entry = snapshot.entriesByAssetId.get(descriptor.sourceAssetId);
      if (!entry)
        throw new Error(
          `Missing Lua source snapshot entry for Asset '${descriptor.sourceAssetId}'.`,
        );
      if (entry.status === 'ready') {
        text = entry.text;
        hash = entry.contentHash;
        physicalKey = `asset:${entry.projectRelativePath}:${entry.contentHash}`;
      } else {
        const supplied = entry.diagnostic as Partial<AuthoringDependencyGraphDiagnostic>;
        await appendDiagnostic(
          descriptor,
          supplied.code ?? 'authoring.lua.source_unavailable',
          supplied.message ??
            `Source Asset '${descriptor.sourceAssetId}' is unavailable in the complete source snapshot.`,
        );
      }
    }
    if (text === undefined) continue;
    if (!(await countSourceBytes(descriptor, text, physicalKey))) continue;
    const artifact = await artifactFor(descriptor.sourceUrl, text, descriptor.sourceKind, hash);
    if (!(await addBound(descriptor, artifact))) continue;

    if (descriptor.sourceKind !== 'rml' || !descriptor.layoutId) continue;
    const queue: {
      text: string;
      assetId?: string;
      sourcePath: string;
      sourceUrl: string;
      depth: number;
    }[] = [
      {
        text,
        assetId: descriptor.sourceAssetId,
        sourcePath: descriptor.sourcePath,
        sourceUrl: descriptor.sourceUrl,
        depth: 0,
      },
    ];
    const visitedTemplates = new Set<string>();
    const visitedScripts = new Set<string>();
    const templateNames = new Map<string, string>();
    const templateUses = new Set<string>();
    let templateCount = 0;
    while (queue.length > 0) {
      const container = queue.shift()!;
      const containingPath = container.assetId ? assetPath(project, container.assetId) : null;
      for (const reference of extractRmlExternalReferences(container.text)) {
        if (reference.kind === 'template-use') {
          templateUses.add(reference.value);
          continue;
        }
        const resolved = resolveLayoutProjectUri(reference.value, containingPath);
        const dependencyIds =
          reference.kind === 'script'
            ? (descriptor.dependencyScriptIds ?? [])
            : (descriptor.dependencyTemplateIds ?? []);
        const assetId = resolved
          ? declaredLayoutDependencyByResolvedPath(
              project,
              dependencyIds,
              reference.kind === 'script' ? 'script' : 'template',
              resolved,
            )
          : null;
        const entry = assetId ? snapshot.entriesByAssetId.get(assetId) : undefined;
        if (!resolved || !assetId || entry?.status !== 'ready') {
          await appendDiagnostic(
            descriptor,
            'authoring.lua.external_source_unresolved',
            `RML ${reference.kind} '${reference.value}' does not resolve to exactly one declared dependency.`,
            container.sourceUrl,
          );
          continue;
        }
        const resolvedPhysicalKey = `asset:${entry.projectRelativePath}:${entry.contentHash}`;
        if (reference.kind === 'template-link') {
          if (visitedTemplates.has(resolvedPhysicalKey)) continue;
          if (
            container.depth >= limits.maxTemplateDepth ||
            templateCount >= limits.maxTemplatesPerLayout
          ) {
            await appendDiagnostic(
              descriptor,
              'authoring.lua.template_limit',
              'RML template traversal reached a fixed depth/count limit.',
              `project:/${entry.projectRelativePath}`,
            );
            continue;
          }
          visitedTemplates.add(resolvedPhysicalKey);
          templateCount += 1;
          for (const name of extractTemplateNames(entry.text)) {
            if (templateNames.has(name)) {
              await appendDiagnostic(
                descriptor,
                'authoring.lua.template_name_duplicate',
                `Duplicate RML template name '${name}'.`,
                `project:/${entry.projectRelativePath}`,
              );
            } else templateNames.set(name, assetId);
          }
          const childDescriptor: AuthoringLuaSourceDescriptor = {
            ...descriptor,
            sourcePath: `/layouts/${escapeJsonPointerSegment(descriptor.layoutId)}/data/dependencies/templates/${dependencyIds.indexOf(assetId)}`,
            sourceUrl: `project:/${entry.projectRelativePath}`,
            sourceAssetId: assetId,
          };
          if (!(await countSourceBytes(childDescriptor, entry.text, resolvedPhysicalKey))) break;
          const childArtifact = await artifactFor(
            childDescriptor.sourceUrl,
            entry.text,
            'rml',
            entry.contentHash,
          );
          if (!(await addBound(childDescriptor, childArtifact))) break;
          queue.push({
            text: entry.text,
            assetId,
            sourcePath: childDescriptor.sourcePath,
            sourceUrl: childDescriptor.sourceUrl,
            depth: container.depth + 1,
          });
        } else {
          if (visitedScripts.has(resolvedPhysicalKey)) continue;
          visitedScripts.add(resolvedPhysicalKey);
          const childDescriptor: AuthoringLuaSourceDescriptor = {
            ...descriptor,
            sourcePath: `/layouts/${escapeJsonPointerSegment(descriptor.layoutId)}/data/dependencies/scripts/${dependencyIds.indexOf(assetId)}`,
            sourceUrl: `project:/${entry.projectRelativePath}`,
            sourceAssetId: assetId,
            sourceKind: 'lua',
          };
          if (!(await countSourceBytes(childDescriptor, entry.text, resolvedPhysicalKey))) break;
          const childArtifact = await artifactFor(
            childDescriptor.sourceUrl,
            entry.text,
            'lua',
            entry.contentHash,
          );
          if (
            !(await addBound(childDescriptor, {
              ...childArtifact,
              regions: childArtifact.regions.map((region) => ({
                ...region,
                sourceKind: 'rml-script-src',
              })),
              literalOccurrences: childArtifact.literalOccurrences.map((literal) => ({
                ...literal,
                sourceKind: 'rml-script-src',
              })),
              managedMessageOccurrences: childArtifact.managedMessageOccurrences.map(
                (occurrence) => ({
                  ...occurrence,
                  sourceLiteral: {
                    ...occurrence.sourceLiteral,
                    sourceKind: 'rml-script-src',
                  },
                }),
              ),
            }))
          )
            break;
        }
      }
      if (blockedOwners.has(descriptor.contributionKey)) break;
    }
    for (const name of [...templateUses].sort())
      if (!templateNames.has(name))
        await appendDiagnostic(
          descriptor,
          'authoring.lua.template_name_missing',
          `Unknown RML template name '${name}'.`,
        );
  }
  return new Map([...output].map(([key, value]) => [key, Object.freeze(value)]));
}

export function semanticOwnerFromSourcePath(path: string): AuthoringDependencyNodeKey | null {
  const segments = parseJsonPointer(path);
  const collection = segments[0];
  const id = segments[1];
  return authoringCollectionKeys.includes(collection as AuthoringCollectionKey) && id
    ? recordKey(collection as AuthoringCollectionKey, id)
    : null;
}
