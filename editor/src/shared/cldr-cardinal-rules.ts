// Cardinal plural rules vendored from Unicode CLDR common/supplemental/plurals.xml.
// Source copyright © 1991-2025 Unicode, Inc.; SPDX-License-Identifier: Unicode-3.0.
// Sample annotations are intentionally omitted. NovelTea compiles the declarative rules below into
// the Compiled Project so the player does not carry a CLDR/ICU runtime dependency.

export const cldrPluralCategories = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
export type CldrPluralCategory = (typeof cldrPluralCategories)[number];
export type CldrPluralOperand = 'n' | 'i' | 'v' | 'w' | 'f' | 't' | 'e';

export interface CldrPluralRange {
  minimum: number;
  maximum: number;
}

export interface CldrPluralRelation {
  operand: CldrPluralOperand;
  modulo: number | null;
  negated: boolean;
  ranges: CldrPluralRange[];
}

export interface CldrPluralRule {
  category: Exclude<CldrPluralCategory, 'other'>;
  alternatives: CldrPluralRelation[][];
}

type RuleSource = readonly [category: Exclude<CldrPluralCategory, 'other'>, expression: string];

const localeRuleSources = new Map<string, readonly RuleSource[]>();

function add(locales: string, rules: readonly RuleSource[]): void {
  for (const raw of locales.split(/\s+/u)) {
    const locale = raw.replaceAll('_', '-');
    localeRuleSources.set(locale.toLowerCase(), rules);
  }
}

add(
  'bm bo dz hnj id ig ii in ja jbo jv jw kde kea km ko lkt lo ms my nqo osa root sah ses sg su th to tpi wo yo yue zh',
  [],
);
add('am as bn doi fa gu hi kn kok kok_Latn pcm tg vi zu', [['one', 'i = 0 or n = 1']]);
add('ff hy kab', [['one', 'i = 0,1']]);
add('ast de en et fi fy ia ie io ji lij nl sc sv sw ur yi', [['one', 'i = 1 and v = 0']]);
add('si', [['one', 'n = 0,1 or i = 0 and f = 1']]);
add('ak bho csw guw ln mg nso pa ti wa', [['one', 'n = 0..1']]);
add('tzm', [['one', 'n = 0..1 or n = 11..99']]);
add(
  'af an asa az bal bem bez bg brx ce cgg chr ckb dv ee el eo eu fo fur gsw ha haw hu jgo jmc ka kaj kcg kk kkj kl ks ksb ku ky lb lg mas mgo ml mn mr nah nb nd ne nn nnh no nr ny nyn om or os pap ps rm rof rwk saq sd sdh seh sn so sq ss ssy st syr ta te teo tig tk tn tr ts ug uz ve vo vun wae xh xog',
  [['one', 'n = 1']],
);
add('da', [['one', 'n = 1 or t != 0 and i = 0,1']]);
add('is', [['one', 't = 0 and i % 10 = 1 and i % 100 != 11 or t % 10 = 1 and t % 100 != 11']]);
add('mk', [['one', 'v = 0 and i % 10 = 1 and i % 100 != 11 or f % 10 = 1 and f % 100 != 11']]);
add('ceb fil tl', [
  ['one', 'v = 0 and i = 1,2,3 or v = 0 and i % 10 != 4,6,9 or v != 0 and f % 10 != 4,6,9'],
]);
add('lv prg', [
  ['zero', 'n % 10 = 0 or n % 100 = 11..19 or v = 2 and f % 100 = 11..19'],
  [
    'one',
    'n % 10 = 1 and n % 100 != 11 or v = 2 and f % 10 = 1 and f % 100 != 11 or v != 2 and f % 10 = 1',
  ],
]);
add('lag', [
  ['zero', 'n = 0'],
  ['one', 'i = 0,1 and n != 0'],
]);
add('blo cv ksh', [
  ['zero', 'n = 0'],
  ['one', 'n = 1'],
]);
add('he iw', [
  ['one', 'i = 1 and v = 0 or i = 0 and v != 0'],
  ['two', 'i = 2 and v = 0'],
]);
add('iu naq sat se sma smi smj smn sms', [
  ['one', 'n = 1'],
  ['two', 'n = 2'],
]);
add('shi', [
  ['one', 'i = 0 or n = 1'],
  ['few', 'n = 2..10'],
]);
add('mo ro', [
  ['one', 'i = 1 and v = 0'],
  ['few', 'v != 0 or n = 0 or n != 1 and n % 100 = 1..19'],
]);
add('bs hr sh sr', [
  ['one', 'v = 0 and i % 10 = 1 and i % 100 != 11 or f % 10 = 1 and f % 100 != 11'],
  ['few', 'v = 0 and i % 10 = 2..4 and i % 100 != 12..14 or f % 10 = 2..4 and f % 100 != 12..14'],
]);
add('fr pt', [
  ['one', 'i = 0..1'],
  ['many', 'e = 0 and i != 0 and i % 1000000 = 0 and v = 0 or e != 0..5'],
]);
add('ca gl it lld pt_PT scn vec', [
  ['one', 'i = 1 and v = 0'],
  ['many', 'e = 0 and i != 0 and i % 1000000 = 0 and v = 0 or e != 0..5'],
]);
add('es', [
  ['one', 'n = 1'],
  ['many', 'e = 0 and i != 0 and i % 1000000 = 0 and v = 0 or e != 0..5'],
]);
add('gd', [
  ['one', 'n = 1,11'],
  ['two', 'n = 2,12'],
  ['few', 'n = 3..10,13..19'],
]);
add('sl', [
  ['one', 'v = 0 and i % 100 = 1'],
  ['two', 'v = 0 and i % 100 = 2'],
  ['few', 'v = 0 and i % 100 = 3..4 or v != 0'],
]);
add('dsb hsb', [
  ['one', 'v = 0 and i % 100 = 1 or f % 100 = 1'],
  ['two', 'v = 0 and i % 100 = 2 or f % 100 = 2'],
  ['few', 'v = 0 and i % 100 = 3..4 or f % 100 = 3..4'],
]);
add('cs sk', [
  ['one', 'i = 1 and v = 0'],
  ['few', 'i = 2..4 and v = 0'],
  ['many', 'v != 0'],
]);
add('pl', [
  ['one', 'i = 1 and v = 0'],
  ['few', 'v = 0 and i % 10 = 2..4 and i % 100 != 12..14'],
  [
    'many',
    'v = 0 and i != 1 and i % 10 = 0..1 or v = 0 and i % 10 = 5..9 or v = 0 and i % 100 = 12..14',
  ],
]);
add('be', [
  ['one', 'n % 10 = 1 and n % 100 != 11'],
  ['few', 'n % 10 = 2..4 and n % 100 != 12..14'],
  ['many', 'n % 10 = 0 or n % 10 = 5..9 or n % 100 = 11..14'],
]);
add('lt', [
  ['one', 'n % 10 = 1 and n % 100 != 11..19'],
  ['few', 'n % 10 = 2..9 and n % 100 != 11..19'],
  ['many', 'f != 0'],
]);
add('ru uk', [
  ['one', 'v = 0 and i % 10 = 1 and i % 100 != 11'],
  ['few', 'v = 0 and i % 10 = 2..4 and i % 100 != 12..14'],
  ['many', 'v = 0 and i % 10 = 0 or v = 0 and i % 10 = 5..9 or v = 0 and i % 100 = 11..14'],
]);
add('sgs', [
  ['one', 'n % 10 = 1 and n % 100 != 11'],
  ['two', 'n = 2'],
  ['few', 'n != 2 and n % 10 = 2..9 and n % 100 != 11..19'],
  ['many', 'f != 0'],
]);
add('br', [
  ['one', 'n % 10 = 1 and n % 100 != 11,71,91'],
  ['two', 'n % 10 = 2 and n % 100 != 12,72,92'],
  ['few', 'n % 10 = 3..4,9 and n % 100 != 10..19,70..79,90..99'],
  ['many', 'n != 0 and n % 1000000 = 0'],
]);
add('mt', [
  ['one', 'n = 1'],
  ['two', 'n = 2'],
  ['few', 'n = 0 or n % 100 = 3..10'],
  ['many', 'n % 100 = 11..19'],
]);
add('ga', [
  ['one', 'n = 1'],
  ['two', 'n = 2'],
  ['few', 'n = 3..6'],
  ['many', 'n = 7..10'],
]);
add('gv', [
  ['one', 'v = 0 and i % 10 = 1'],
  ['two', 'v = 0 and i % 10 = 2'],
  ['few', 'v = 0 and i % 100 = 0,20,40,60,80'],
  ['many', 'v != 0'],
]);
add('kw', [
  ['zero', 'n = 0'],
  ['one', 'n = 1'],
  [
    'two',
    'n % 100 = 2,22,42,62,82 or n % 1000 = 0 and n % 100000 = 1000..20000,40000,60000,80000 or n != 0 and n % 1000000 = 100000',
  ],
  ['few', 'n % 100 = 3,23,43,63,83'],
  ['many', 'n != 1 and n % 100 = 1,21,41,61,81'],
]);
add('ar ars', [
  ['zero', 'n = 0'],
  ['one', 'n = 1'],
  ['two', 'n = 2'],
  ['few', 'n % 100 = 3..10'],
  ['many', 'n % 100 = 11..99'],
]);
add('cy', [
  ['zero', 'n = 0'],
  ['one', 'n = 1'],
  ['two', 'n = 2'],
  ['few', 'n = 3'],
  ['many', 'n = 6'],
]);

function parseRange(value: string): CldrPluralRange {
  const [minimumText, maximumText = minimumText] = value.split('..');
  const minimum = Number(minimumText);
  const maximum = Number(maximumText);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum > maximum)
    throw new Error(`Invalid CLDR plural range '${value}'.`);
  return { minimum, maximum };
}

function parseRelation(value: string): CldrPluralRelation {
  const match = /^(n|i|v|w|f|t|e)(?:\s*%\s*(\d+))?\s*(!=|=)\s*(.+)$/u.exec(value.trim());
  if (!match) throw new Error(`Invalid CLDR plural relation '${value}'.`);
  const operand = match[1] as CldrPluralOperand;
  const modulo = match[2] === undefined ? null : Number(match[2]);
  const negated = match[3] === '!=';
  const ranges = match[4]!.split(',').map((item) => parseRange(item.trim()));
  return { operand, modulo, negated, ranges };
}

function parseRule([category, expression]: RuleSource): CldrPluralRule {
  return {
    category,
    alternatives: expression
      .split(/\s+or\s+/u)
      .map((alternative) => alternative.split(/\s+and\s+/u).map(parseRelation)),
  };
}

function localeCandidates(locale: string): string[] {
  let canonical = locale;
  try {
    canonical = Intl.getCanonicalLocales(locale)[0] ?? locale;
  } catch {
    // Project validation reports invalid locale tags separately.
  }
  const parsed = canonical.split('-');
  const language = parsed[0]?.toLowerCase() ?? canonical.toLowerCase();
  const script = parsed.find((part) => part.length === 4);
  const region = parsed.find((part) => part.length === 2 || /^\d{3}$/u.test(part));
  return [
    canonical.toLowerCase(),
    script ? `${language}-${script.toLowerCase()}` : '',
    region ? `${language}-${region.toLowerCase()}` : '',
    language,
  ].filter(Boolean);
}

export function cldrCardinalRules(locale: string): CldrPluralRule[] {
  for (const candidate of localeCandidates(locale)) {
    const rules = localeRuleSources.get(candidate);
    if (rules) return rules.map(parseRule);
  }
  return [];
}

export function cldrCardinalCategories(locale: string): CldrPluralCategory[] {
  return [...cldrCardinalRules(locale).map((rule) => rule.category), 'other'];
}

type PluralOperands = Record<CldrPluralOperand, number>;

function pluralOperands(value: number): PluralOperands {
  const absolute = Math.abs(value);
  const rounded = Math.round(absolute * 1000) / 1000;
  const integer = Math.floor(rounded);
  let fraction = Math.round((rounded - integer) * 1000);
  let visibleDigits = fraction === 0 ? 0 : 3;
  while (fraction !== 0 && fraction % 10 === 0) {
    fraction /= 10;
    visibleDigits -= 1;
  }
  return {
    n: rounded,
    i: integer,
    v: visibleDigits,
    w: visibleDigits,
    f: fraction,
    t: fraction,
    e: 0,
  };
}

function relationMatches(operands: PluralOperands, relation: CldrPluralRelation): boolean {
  let candidate = operands[relation.operand];
  if (relation.modulo !== null) candidate %= relation.modulo;
  const integerRelation = relation.ranges.every(
    (range) => Number.isInteger(range.minimum) && Number.isInteger(range.maximum),
  );
  const matched =
    (!integerRelation || Number.isInteger(candidate)) &&
    relation.ranges.some((range) => candidate >= range.minimum && candidate <= range.maximum);
  return relation.negated ? !matched : matched;
}

export function cldrCardinalCategory(locale: string, value: number): CldrPluralCategory {
  if (!Number.isFinite(value)) return 'other';
  const operands = pluralOperands(value);
  for (const rule of cldrCardinalRules(locale))
    if (
      rule.alternatives.some((alternative) =>
        alternative.every((relation) => relationMatches(operands, relation)),
      )
    )
      return rule.category;
  return 'other';
}
