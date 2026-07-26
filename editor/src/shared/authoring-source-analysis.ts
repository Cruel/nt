import { createHash } from 'node:crypto';
import path from 'node:path';
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
  type AuthoringLiteralOccurrence,
  type AuthoringSourceAnalysisArtifact,
  type AuthoringSourceContentArtifact,
  type EmbeddedLuaSourceKind,
  type EmbeddedLuaSourceRegion,
  type LuaSourceSnapshot,
  type OwnerNeutralEmbeddedLuaSourceRegion,
  type OwnerNeutralLiteralOccurrence,
} from './project-schema/authoring-lua-analysis';
import type { AuthoringProject } from './project-schema/authoring-project';
import {
  authoringCollectionKeys,
  type AuthoringCollectionKey,
} from './project-schema/authoring-collections';
import { parseLayoutData } from './project-schema/authoring-layouts';
import { parseScriptModuleData } from './project-schema/authoring-script-modules';
import { parseAssetData } from './project-schema/authoring-assets';

const utf8 = new TextEncoder();
const sha256 = (value: string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

export type AuthoringLuaSourceDescriptor = {
  contributionKey: AuthoringDependencyContributionKey;
  semanticOwner: AuthoringDependencyNodeKey;
  sourcePath: string;
  sourceKind: 'lua' | 'rml';
  sourceUrl: string;
  inlineText?: string;
  sourceAssetId?: string;
  focusedAdmission: boolean;
  explicitDependenciesPath?: string;
  explicitDependencies?: readonly unknown[];
  layoutId?: string;
  dependencyScriptIds?: readonly string[];
  dependencyTemplateIds?: readonly string[];
};

const recordKey = (collection: AuthoringCollectionKey, id: string): AuthoringDependencyNodeKey => ({
  kind: 'record',
  collection,
  id,
});
const recordContributionKey = (collection: AuthoringCollectionKey, id: string) =>
  `record:${JSON.stringify(['record', collection, id])}`;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const AUTHORING_LUA_SCHEMA_SOURCE_KINDS = Object.freeze([
  'lua-predicate',
  'lua-expression',
  'run-lua-effect',
  'run-lua',
] as const);

export const AUTHORING_LUA_SOURCE_REGISTRY = Object.freeze({
  projectFields: Object.freeze(['/startupHook/source'] as const),
  dedicatedCollections: Object.freeze(['scripts', 'layouts'] as const),
  sharedSchemaCollections: Object.freeze([
    'rooms',
    'characters',
    'interactables',
    'scenes',
    'dialogues',
    'verbs',
    'interactions',
    'tests',
    'maps',
  ] as const satisfies readonly AuthoringCollectionKey[]),
  sharedKinds: AUTHORING_LUA_SCHEMA_SOURCE_KINDS,
});

function collectRegisteredSchemaLuaFields(
  value: unknown,
  path: string[],
  owner: AuthoringDependencyNodeKey,
  contributionKey: string,
  output: AuthoringLuaSourceDescriptor[],
) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectRegisteredSchemaLuaFields(
        item,
        [...path, String(index)],
        owner,
        contributionKey,
        output,
      ),
    );
    return;
  }
  if (!isObject(value)) return;
  const kind = typeof value.kind === 'string' ? value.kind : null;
  const source = typeof value.source === 'string' ? value.source : null;
  const isLua =
    AUTHORING_LUA_SCHEMA_SOURCE_KINDS.includes(
      kind as (typeof AUTHORING_LUA_SCHEMA_SOURCE_KINDS)[number],
    ) && source !== null;
  if (isLua) {
    const sourcePath = buildJsonPointer([...path, 'source']);
    output.push({
      contributionKey,
      semanticOwner: owner,
      sourcePath,
      sourceKind: 'lua',
      sourceUrl: `authoring:${sourcePath}`,
      inlineText: source,
      focusedAdmission: true,
      explicitDependenciesPath: isObject(value.additionalDependencies)
        ? buildJsonPointer([...path, 'additionalDependencies'])
        : undefined,
      explicitDependencies:
        isObject(value.additionalDependencies) &&
        Array.isArray(value.additionalDependencies.targets)
          ? value.additionalDependencies.targets
          : undefined,
    });
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'additionalDependencies') continue;
    collectRegisteredSchemaLuaFields(child, [...path, key], owner, contributionKey, output);
  }
}

export function collectAuthoringLuaSources(
  project: AuthoringProject,
): readonly AuthoringLuaSourceDescriptor[] {
  const output: AuthoringLuaSourceDescriptor[] = [];
  if (project.startupHook) {
    output.push({
      contributionKey: `project-field:${JSON.stringify('/startupHook')}`,
      semanticOwner: { kind: 'project-field', path: '/startupHook' },
      sourcePath: '/startupHook/source',
      sourceKind: 'lua',
      sourceUrl: 'authoring:/startupHook/source',
      inlineText: project.startupHook.source,
      focusedAdmission: true,
    });
  }
  for (const [id, record] of Object.entries(project.scripts).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const parsed = parseScriptModuleData(record.data);
    if (!parsed) continue;
    const base = `/scripts/${escapeJsonPointerSegment(id)}/data/source`;
    output.push({
      contributionKey: recordContributionKey('scripts', id),
      semanticOwner: recordKey('scripts', id),
      sourcePath: parsed.source.kind === 'inline-lua' ? `${base}/source` : `${base}/asset/$ref`,
      sourceKind: 'lua',
      sourceUrl:
        parsed.source.kind === 'inline-lua'
          ? `authoring:${base}/source`
          : `asset:${parsed.source.asset.$ref.id}`,
      inlineText: parsed.source.kind === 'inline-lua' ? parsed.source.source : undefined,
      sourceAssetId: parsed.source.kind === 'asset' ? parsed.source.asset.$ref.id : undefined,
      focusedAdmission: true,
    });
  }
  for (const [id, record] of Object.entries(project.layouts).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const parsed = parseLayoutData(record.data);
    if (!parsed) continue;
    const owner = recordKey('layouts', id);
    const contributionKey = recordContributionKey('layouts', id);
    for (const [name, sourceKind] of [
      ['lua', 'lua'],
      ['rml', 'rml'],
    ] as const) {
      const source = parsed[name];
      const base = `/layouts/${escapeJsonPointerSegment(id)}/data/${name}`;
      output.push({
        contributionKey,
        semanticOwner: owner,
        sourcePath:
          source.sourceMode === 'inline' ? `${base}/sourceText` : `${base}/sourceAsset/$ref`,
        sourceKind,
        sourceUrl:
          source.sourceMode === 'inline'
            ? `authoring:${base}/sourceText`
            : `asset:${source.sourceAsset?.$ref.id ?? 'missing'}`,
        inlineText: source.sourceMode === 'inline' ? source.sourceText : undefined,
        sourceAssetId: source.sourceMode === 'asset' ? source.sourceAsset?.$ref.id : undefined,
        focusedAdmission: name === 'rml' || parsed.script.enabled,
        explicitDependenciesPath:
          name === 'lua'
            ? `/layouts/${escapeJsonPointerSegment(id)}/data/script/additionalDependencies`
            : undefined,
        explicitDependencies:
          name === 'lua' ? parsed.script.additionalDependencies?.targets : undefined,
        layoutId: id,
        dependencyScriptIds: parsed.dependencies.scripts.map((ref) => ref.$ref.id),
        dependencyTemplateIds: (parsed.dependencies.templates ?? []).map((ref) => ref.$ref.id),
      });
    }
  }
  for (const collection of AUTHORING_LUA_SOURCE_REGISTRY.sharedSchemaCollections) {
    for (const [id, record] of Object.entries(project[collection]).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      collectRegisteredSchemaLuaFields(
        record.data,
        [collection, id, 'data'],
        recordKey(collection, id),
        recordContributionKey(collection, id),
        output,
      );
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

function decodeLuaQuoted(raw: string, quote: string): string {
  let result = '';
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
    else if (next === 'z') while (/\s/.test(raw[index + 1] ?? '')) index += 1;
    else if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(raw.slice(index + 1, index + 3))) {
      result += String.fromCodePoint(Number.parseInt(raw.slice(index + 1, index + 3), 16));
      index += 2;
    } else if (next === 'u' && raw[index + 1] === '{') {
      const end = raw.indexOf('}', index + 2);
      const digits = raw.slice(index + 2, end);
      if (end >= 0 && /^[0-9a-fA-F]+$/.test(digits)) {
        result += String.fromCodePoint(Number.parseInt(digits, 16));
        index = end;
      } else result += next;
    } else if (/\d/.test(next)) {
      const digits = next + (raw.slice(index + 1).match(/^\d{0,2}/)?.[0] ?? '');
      result += String.fromCodePoint(Number.parseInt(digits, 10));
      index += digits.length - 1;
    } else if (next === '\n') result += '\n';
    else if (next === '\r') {
      if (raw[index + 1] === '\n') index += 1;
      result += '\n';
    } else result += next ?? quote;
  }
  return result;
}

export function lexLuaStringLiterals(source: string): {
  literals: readonly LiteralToken[];
  complete: boolean;
} {
  const literals: LiteralToken[] = [];
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
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    const quote = source[index];
    if (quote === "'" || quote === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < source.length) {
        const char = source[index++];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
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
      literals.push({
        regionStartUtf16: start,
        regionEndUtf16: index,
        ...location,
        rawLiteral: raw,
        decodedValue: decodeLuaQuoted(raw, quote),
        literalKind: quote === "'" ? 'single-quoted' : 'double-quoted',
      });
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
        literals.push({
          regionStartUtf16: start,
          regionEndUtf16: end + endMarker.length,
          ...location,
          rawLiteral: raw,
          decodedValue,
          literalKind: 'long-bracket',
        });
        index = end + endMarker.length;
        continue;
      }
    }
    index += 1;
  }
  return { literals: Object.freeze(literals), complete };
}

type RawRegion = {
  kind: EmbeddedLuaSourceKind;
  text: string;
  line: number;
  column: number;
  sourceUrl: string;
  parentRegionOrdinal?: number;
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
  const open = /<(script|style)\b/gi;
  while (true) {
    open.lastIndex = cursor;
    const match = open.exec(source);
    if (!match) break;
    let tagEnd = open.lastIndex;
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
    if (/\/\s*>$/.test(source.slice(match.index, tagEnd + 1))) {
      cursor = tagEnd + 1;
      continue;
    }
    const closeRe = new RegExp(`</${match[1]}\\s*>`, 'ig');
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
    if (match[1].toLowerCase() === 'script')
      scripts.push({ start: match.index, end: closeRe.lastIndex, bodyStart, bodyEnd });
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
  const parser = new SaxesParser({ xmlns: false, position: true });
  parser.on('opentag', (tag: SaxesTag) => {
    for (const [attributeName, attributeValue] of Object.entries(tag.attributes)) {
      const attribute =
        typeof attributeValue === 'string'
          ? { name: attributeName, value: attributeValue }
          : attributeValue;
      const name = attribute.name.toLowerCase();
      if (/^on[\p{L}_:][\p{L}\p{N}_.:-]*$/u.test(name))
        regions.push({
          kind: 'rml-event-attribute',
          text: attribute.value,
          line: parser.line + 1,
          column: parser.column + 1,
          sourceUrl,
        });
    }
  });
  parser.on('error', (error) =>
    diagnostics.push({
      severity: 'warning',
      code: 'authoring.lua.rml_parse',
      path: '',
      message: error.message,
    }),
  );
  try {
    parser.write(masked.masked).close();
  } catch {
    /* saxes already reported */
  }
  for (const script of masked.scripts) {
    const location = locationAt(text, script.bodyStart);
    const startTag = text.slice(script.start, script.bodyStart);
    const src = startTag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!src)
      regions.push({
        kind: 'rml-inline-script',
        text: text.slice(script.bodyStart, script.bodyEnd),
        ...location,
        sourceUrl,
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
    if (name === 'script' && attributes.src)
      references.push({ kind: 'script', value: attributes.src });
    if (
      name === 'link' &&
      attributes.type?.trim().toLowerCase() === 'text/template' &&
      attributes.href
    )
      references.push({ kind: 'template-link', value: attributes.href });
    if (name === 'template' && attributes.src)
      references.push({ kind: 'template-use', value: attributes.src.trim() });
    if (name === 'body' && attributes.template)
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

function resolveProjectUri(uri: string, containingPath: string | null): string | null {
  const trimmed = uri.trim();
  if (
    !trimmed ||
    /[?#\\]/.test(trimmed) ||
    trimmed.startsWith('//') ||
    /^[a-zA-Z]:/.test(trimmed) ||
    (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !trimmed.startsWith('project:/'))
  )
    return null;
  const relative = trimmed.startsWith('project:/') ? trimmed.slice('project:/'.length) : trimmed;
  const base = containingPath ? path.posix.dirname(containingPath) : '';
  const normalized = path.posix.normalize(
    trimmed.startsWith('project:/') ? relative : path.posix.join(base, relative),
  );
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    normalized.startsWith('/')
  )
    return null;
  return normalized;
}

function assetPath(project: AuthoringProject, assetId: string): string | null {
  return parseAssetData(project.assets[assetId]?.data)?.source.path ?? null;
}

function dependencyByResolvedPath(
  project: AuthoringProject,
  ids: readonly string[],
  requiredKind: 'script' | 'template',
  resolvedPath: string,
): string | null {
  const matches = ids.filter((id) => {
    const data = parseAssetData(project.assets[id]?.data);
    if (!data || data.source.path !== resolvedPath) return false;
    return requiredKind === 'script'
      ? data.kind === 'script'
      : data.kind === 'text' && path.posix.extname(data.source.path).toLowerCase() === '.rml';
  });
  return matches.length === 1 ? matches[0] : null;
}

function nestedStringRegions(region: RawRegion, parentOrdinal: number): RawRegion[] {
  const result: RawRegion[] = [];
  const tokens = lexLuaStringLiterals(region.text).literals;
  const recognizer = /\b(?:AddEventListener|load)\s*\(\s*$/;
  for (const token of tokens) {
    const prefix = region.text.slice(
      Math.max(0, token.regionStartUtf16 - 128),
      token.regionStartUtf16,
    );
    const match = prefix.match(recognizer);
    if (!match) continue;
    result.push({
      kind: match[0].includes('AddEventListener') ? 'lua-listener-string' : 'lua-load-string',
      text: token.decodedValue,
      line: token.line,
      column: token.column,
      sourceUrl: region.sourceUrl,
      parentRegionOrdinal: parentOrdinal,
    });
  }
  return result;
}

export function analyzeAuthoringSourceContent(input: {
  sourceUrl: string;
  text: string;
  kind: 'lua' | 'rml';
  contentHash?: `sha256:${string}`;
}): AuthoringSourceContentArtifact {
  const contentHash = input.contentHash ?? sha256(input.text);
  const fingerprint = sha256(JSON.stringify([input.sourceUrl, contentHash]));
  if (utf8.encode(input.text).byteLength > LUA_REFERENCE_ANALYSIS_LIMITS.maxSourceBytes)
    return {
      analyzerVersion: AUTHORING_SOURCE_ANALYZER_VERSION,
      sourceContentFingerprint: fingerprint,
      regions: [],
      literalOccurrences: [],
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
      : {
          regions: [
            {
              kind: 'lua-field' as const,
              text: input.text,
              line: 1,
              column: 1,
              sourceUrl: input.sourceUrl,
            },
          ],
          diagnostics: [],
          complete: true,
        };
  const rawRegions = [...extracted.regions];
  for (
    let index = 0;
    index < rawRegions.length &&
    index < LUA_REFERENCE_ANALYSIS_LIMITS.maxEmbeddedListenerDepth * 1024;
    index += 1
  )
    rawRegions.push(...nestedStringRegions(rawRegions[index], index));
  const regions: OwnerNeutralEmbeddedLuaSourceRegion[] = [];
  const literals: OwnerNeutralLiteralOccurrence[] = [];
  let complete = extracted.complete;
  rawRegions.forEach((region, regionOrdinal) => {
    regions.push({
      sourceUrl: region.sourceUrl,
      sourceKind: region.kind,
      containerContentHash: fingerprint,
      regionOrdinal,
      parentRegionOrdinal: region.parentRegionOrdinal,
      containerLine: region.line,
      containerColumn: region.column,
      decodedSource: region.text,
    });
    const lexed = lexLuaStringLiterals(region.text);
    complete &&= lexed.complete;
    for (const literal of lexed.literals)
      literals.push({
        ...literal,
        sourceUrl: region.sourceUrl,
        sourceContentHash: fingerprint,
        regionOrdinal,
        sourceKind: region.kind,
      });
  });
  return {
    analyzerVersion: AUTHORING_SOURCE_ANALYZER_VERSION,
    sourceContentFingerprint: fingerprint,
    regions: Object.freeze(regions),
    literalOccurrences: Object.freeze(literals),
    diagnostics: Object.freeze(
      extracted.diagnostics.map((diagnostic) => ({ ...diagnostic, sourceUrl: input.sourceUrl })),
    ),
    complete,
  };
}

export function bindAuthoringSourceOwner(
  descriptor: AuthoringLuaSourceDescriptor,
  artifacts: readonly AuthoringSourceContentArtifact[],
): AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic> {
  const regions: EmbeddedLuaSourceRegion[] = [];
  const literals: AuthoringLiteralOccurrence[] = [];
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
    diagnostics.push(
      ...artifact.diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        code: diagnostic.code,
        path: descriptor.sourcePath,
        message: diagnostic.message,
      })),
    );
  }
  return {
    semanticOwnerKey: descriptor.contributionKey,
    analyzerVersion: AUTHORING_SOURCE_ANALYZER_VERSION,
    sourceContentFingerprints: artifacts.map((artifact) => artifact.sourceContentFingerprint),
    ownerProjectionFingerprint: sha256(
      JSON.stringify([
        descriptor.contributionKey,
        descriptor.sourcePath,
        descriptor.sourceAssetId ?? null,
      ]),
    ),
    sourceAssetIds: descriptor.sourceAssetId ? [descriptor.sourceAssetId] : [],
    regions: Object.freeze(regions),
    literalOccurrences: Object.freeze(literals),
    diagnostics: Object.freeze(diagnostics),
    complete: artifacts.every((artifact) => artifact.complete),
  };
}

export function collectAuthoringSourceRequirements(project: AuthoringProject): readonly string[] {
  const ids = new Set<string>();
  for (const descriptor of collectAuthoringLuaSources(project))
    if (descriptor.sourceAssetId) ids.add(descriptor.sourceAssetId);
  for (const record of Object.values(project.layouts)) {
    const layout = parseLayoutData(record.data);
    if (!layout) continue;
    for (const ref of [...layout.dependencies.scripts, ...(layout.dependencies.templates ?? [])])
      ids.add(ref.$ref.id);
  }
  return Object.freeze([...ids].sort());
}

export function analyzeAuthoringSources(
  project: AuthoringProject,
  snapshot: LuaSourceSnapshot,
  limits: {
    [K in keyof typeof LUA_REFERENCE_ANALYSIS_LIMITS]: number;
  } = LUA_REFERENCE_ANALYSIS_LIMITS,
): ReadonlyMap<
  string,
  readonly AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[]
> {
  let bytes = 0;
  let occurrences = 0;
  const output = new Map<
    string,
    AuthoringSourceAnalysisArtifact<AuthoringDependencyGraphDiagnostic>[]
  >();
  const cache = new Map<string, AuthoringSourceContentArtifact>();
  const addBound = (
    descriptor: AuthoringLuaSourceDescriptor,
    artifact: AuthoringSourceContentArtifact,
  ) => {
    const bound = bindAuthoringSourceOwner(descriptor, [artifact]);
    const list = output.get(descriptor.contributionKey) ?? [];
    const currentOccurrences = list.reduce((sum, item) => sum + item.literalOccurrences.length, 0);
    if (
      currentOccurrences + bound.literalOccurrences.length >
      limits.maxLiteralOccurrencesPerSemanticOwner
    ) {
      list.push({
        ...bound,
        regions: [],
        literalOccurrences: [],
        diagnostics: Object.freeze([
          ...bound.diagnostics,
          {
            severity: 'warning',
            code: 'authoring.lua.owner_occurrence_limit',
            path: descriptor.sourcePath,
            message: 'Semantic owner exceeds the fixed literal-occurrence analysis limit.',
          },
        ]),
        complete: false,
      });
    } else list.push(bound);
    output.set(descriptor.contributionKey, list);
  };
  const artifactFor = (
    sourceUrl: string,
    text: string,
    kind: 'lua' | 'rml',
    hash?: `sha256:${string}`,
  ) => {
    const key = `${kind}:${sourceUrl}:${hash ?? sha256(text)}`;
    let artifact = cache.get(key);
    if (!artifact) {
      artifact = analyzeAuthoringSourceContent({ sourceUrl, text, kind, contentHash: hash });
      cache.set(key, artifact);
    }
    return artifact;
  };
  for (const descriptor of collectAuthoringLuaSources(project)) {
    let text: string | undefined = descriptor.inlineText;
    let hash: `sha256:${string}` | undefined;
    if (descriptor.sourceAssetId) {
      const entry = snapshot.entriesByAssetId.get(descriptor.sourceAssetId);
      if (entry?.status === 'ready') {
        text = entry.text;
        hash = entry.contentHash;
      }
    }
    if (text === undefined) continue;
    bytes += utf8.encode(text).byteLength;
    if (bytes > limits.maxSnapshotBytes) break;
    const artifact = artifactFor(descriptor.sourceUrl, text, descriptor.sourceKind, hash);
    occurrences += artifact.literalOccurrences.length;
    if (occurrences > limits.maxSnapshotLiteralOccurrences) break;
    addBound(descriptor, artifact);

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
        const resolved = resolveProjectUri(reference.value, containingPath);
        const dependencyIds =
          reference.kind === 'script'
            ? (descriptor.dependencyScriptIds ?? [])
            : (descriptor.dependencyTemplateIds ?? []);
        const assetId = resolved
          ? dependencyByResolvedPath(
              project,
              dependencyIds,
              reference.kind === 'script' ? 'script' : 'template',
              resolved,
            )
          : null;
        const entry = assetId ? snapshot.entriesByAssetId.get(assetId) : undefined;
        if (!resolved || !assetId || entry?.status !== 'ready') {
          addBound(descriptor, {
            analyzerVersion: AUTHORING_SOURCE_ANALYZER_VERSION,
            sourceContentFingerprint: sha256(reference.value),
            regions: [],
            literalOccurrences: [],
            diagnostics: [
              {
                code: 'authoring.lua.external_source_unresolved',
                severity: 'warning',
                message: `RML ${reference.kind} '${reference.value}' does not resolve to exactly one declared dependency.`,
                sourceUrl: container.sourceUrl,
              },
            ],
            complete: false,
          });
          continue;
        }
        if (reference.kind === 'template-link') {
          if (visitedTemplates.has(assetId)) continue;
          if (
            container.depth >= limits.maxTemplateDepth ||
            templateCount >= limits.maxTemplatesPerLayout
          ) {
            addBound(descriptor, {
              analyzerVersion: AUTHORING_SOURCE_ANALYZER_VERSION,
              sourceContentFingerprint: entry.contentHash,
              regions: [],
              literalOccurrences: [],
              diagnostics: [
                {
                  code: 'authoring.lua.template_limit',
                  severity: 'warning',
                  message: 'RML template traversal reached a fixed depth/count limit.',
                  sourceUrl: `asset:${assetId}`,
                },
              ],
              complete: false,
            });
            continue;
          }
          visitedTemplates.add(assetId);
          templateCount += 1;
          for (const name of extractTemplateNames(entry.text)) {
            if (templateNames.has(name)) {
              addBound(descriptor, {
                analyzerVersion: AUTHORING_SOURCE_ANALYZER_VERSION,
                sourceContentFingerprint: entry.contentHash,
                regions: [],
                literalOccurrences: [],
                diagnostics: [
                  {
                    code: 'authoring.lua.template_name_duplicate',
                    severity: 'warning',
                    message: `Duplicate RML template name '${name}'.`,
                    sourceUrl: `asset:${assetId}`,
                  },
                ],
                complete: false,
              });
            } else templateNames.set(name, assetId);
          }
          const childDescriptor: AuthoringLuaSourceDescriptor = {
            ...descriptor,
            sourcePath: `/layouts/${escapeJsonPointerSegment(descriptor.layoutId)}/data/dependencies/templates/${dependencyIds.indexOf(assetId)}`,
            sourceUrl: `asset:${assetId}`,
            sourceAssetId: assetId,
          };
          const childArtifact = artifactFor(
            childDescriptor.sourceUrl,
            entry.text,
            'rml',
            entry.contentHash,
          );
          occurrences += childArtifact.literalOccurrences.length;
          addBound(childDescriptor, childArtifact);
          queue.push({
            text: entry.text,
            assetId,
            sourcePath: childDescriptor.sourcePath,
            sourceUrl: childDescriptor.sourceUrl,
            depth: container.depth + 1,
          });
        } else {
          const childDescriptor: AuthoringLuaSourceDescriptor = {
            ...descriptor,
            sourcePath: `/layouts/${escapeJsonPointerSegment(descriptor.layoutId)}/data/dependencies/scripts/${dependencyIds.indexOf(assetId)}`,
            sourceUrl: `asset:${assetId}`,
            sourceAssetId: assetId,
            sourceKind: 'lua',
          };
          const childArtifact = artifactFor(
            childDescriptor.sourceUrl,
            entry.text,
            'lua',
            entry.contentHash,
          );
          occurrences += childArtifact.literalOccurrences.length;
          addBound(childDescriptor, {
            ...childArtifact,
            regions: childArtifact.regions.map((region) => ({
              ...region,
              sourceKind: 'rml-script-src',
            })),
            literalOccurrences: childArtifact.literalOccurrences.map((literal) => ({
              ...literal,
              sourceKind: 'rml-script-src',
            })),
          });
        }
      }
    }
    for (const name of [...templateUses].sort())
      if (!templateNames.has(name))
        addBound(descriptor, {
          analyzerVersion: AUTHORING_SOURCE_ANALYZER_VERSION,
          sourceContentFingerprint: sha256(name),
          regions: [],
          literalOccurrences: [],
          diagnostics: [
            {
              code: 'authoring.lua.template_name_missing',
              severity: 'warning',
              message: `Unknown RML template name '${name}'.`,
              sourceUrl: descriptor.sourceUrl,
            },
          ],
          complete: false,
        });
  }
  if (bytes > limits.maxSnapshotBytes || occurrences > limits.maxSnapshotLiteralOccurrences) {
    const first = collectAuthoringLuaSources(project)[0];
    if (first)
      addBound(first, {
        analyzerVersion: AUTHORING_SOURCE_ANALYZER_VERSION,
        sourceContentFingerprint: sha256('snapshot-limit'),
        regions: [],
        literalOccurrences: [],
        diagnostics: [
          {
            code: 'authoring.lua.snapshot_limit',
            severity: 'warning',
            message: 'Complete source snapshot exceeded a fixed byte or occurrence limit.',
            sourceUrl: first.sourceUrl,
          },
        ],
        complete: false,
      });
  }
  return new Map([...output].map(([key, value]) => [key, Object.freeze(value)]));
}

export function semanticOwnerFromSourcePath(path: string): AuthoringDependencyNodeKey | null {
  const segments = parseJsonPointer(path);
  if (segments[0] === 'startupHook') return { kind: 'project-field', path: '/startupHook' };
  const collection = segments[0];
  const id = segments[1];
  return authoringCollectionKeys.includes(collection as AuthoringCollectionKey) && id
    ? recordKey(collection as AuthoringCollectionKey, id)
    : null;
}
