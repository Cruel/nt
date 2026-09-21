import { describe, expect, it } from 'vite-plus/test';
import {
  overlayReadonlyArray,
  overlayReadonlyMap,
  overlayReadonlyRecord,
} from '../../shared/bounded-structural-sharing';

describe('bounded structural sharing', () => {
  it('keeps record, array, and map lookups bounded across long overlay histories', () => {
    let record: Readonly<Record<string, number>> = { stable: 1, value: 0 };
    let array: readonly number[] = [1, 0, 3];
    let map: ReadonlyMap<string, number> = new Map([
      ['stable', 1],
      ['value', 0],
      ['rotating', 0],
    ]);

    for (let index = 1; index <= 20_000; index += 1) {
      record = overlayReadonlyRecord(record, { value: index });
      array = overlayReadonlyArray(array, new Map([[1, index]]));
      map = overlayReadonlyMap(
        map,
        new Map([
          ['value', index],
          ['rotating', index],
        ]),
        index % 7 === 0 ? new Set(['rotating']) : new Set(),
      );
    }

    expect(record.stable).toBe(1);
    expect(record.value).toBe(20_000);
    expect(Object.entries(record).sort(([left], [right]) => left.localeCompare(right))).toEqual([
      ['stable', 1],
      ['value', 20_000],
    ]);

    expect(array).toEqual([1, 20_000, 3]);
    expect(array[1]).toBe(20_000);

    expect(map.get('stable')).toBe(1);
    expect(map.get('value')).toBe(20_000);
    expect(map.get('rotating')).toBe(20_000);
    expect([...map]).toEqual([
      ['stable', 1],
      ['value', 20_000],
      ['rotating', 20_000],
    ]);
  });

  it('keeps canonically equivalent Unicode paths as distinct keys across generations', () => {
    const composed = 'assets/\u00e9.lua';
    const decomposed = 'assets/e\u0301.lua';
    const firstMap = overlayReadonlyMap(new Map<string, number>(), new Map([[composed, 1]]));
    const secondMap = overlayReadonlyMap(firstMap, new Map([[decomposed, 2]]));
    const thirdMap = overlayReadonlyMap(secondMap, new Map([[composed, 3]]), new Set([decomposed]));
    expect(firstMap.size).toBe(1);
    expect(firstMap.has(decomposed)).toBe(false);
    expect([...secondMap]).toEqual([
      [composed, 1],
      [decomposed, 2],
    ]);
    expect(secondMap.size).toBe(2);
    expect(secondMap.get(composed)).toBe(1);
    expect(secondMap.get(decomposed)).toBe(2);
    expect([...thirdMap]).toEqual([[composed, 3]]);
    expect(thirdMap.size).toBe(1);
    expect(thirdMap.has(decomposed)).toBe(false);

    const firstRecord = overlayReadonlyRecord({}, { [composed]: 1 });
    const secondRecord = overlayReadonlyRecord(firstRecord, { [decomposed]: 2 });
    expect(firstRecord[decomposed]).toBeUndefined();
    expect(Object.entries(secondRecord)).toEqual([
      [composed, 1],
      [decomposed, 2],
    ]);
    expect(secondRecord[composed]).toBe(1);
    expect(secondRecord[decomposed]).toBe(2);
  });

  it('preserves explicit null and undefined overrides instead of returning the root value', () => {
    const record = overlayReadonlyRecord<number | null | undefined>(
      { nullable: 1, optional: 2 },
      { nullable: null, optional: undefined },
    );
    expect(record.nullable).toBeNull();
    expect(record.optional).toBeUndefined();
    expect(Object.hasOwn(record, 'optional')).toBe(true);
    const array = overlayReadonlyArray<number | null | undefined>(
      [1, 2],
      new Map([
        [0, null],
        [1, undefined],
      ]),
    );
    expect([...array]).toEqual([null, undefined]);
  });

  it('preserves Map delete/reinsert iteration semantics across generations', () => {
    let map: ReadonlyMap<string, number> = new Map([
      ['first', 1],
      ['moved', 2],
      ['last', 3],
    ]);

    for (let index = 0; index < 40; index += 1)
      map = overlayReadonlyMap(map, new Map([['first', index]]));
    map = overlayReadonlyMap(map, new Map(), new Set(['moved']));
    map = overlayReadonlyMap(map, new Map([['moved', 4]]));

    expect([...map.keys()]).toEqual(['first', 'last', 'moved']);
    expect(map.get('moved')).toBe(4);
  });

  it('updates distinct historical keys without rescanning prior Map deltas', () => {
    let map: ReadonlyMap<string, number> = new Map([['stable', 1]]);
    let record: Readonly<Record<string, number>> = { stable: 1 };
    const arrayRoot = Array.from({ length: 2_000 }, () => 0);
    let array: readonly number[] = arrayRoot;

    const mapPrototype = Map.prototype as unknown as Record<PropertyKey, unknown>;
    const originalIterator = Map.prototype[Symbol.iterator] as unknown as (
      this: Map<unknown, unknown>,
    ) => IterableIterator<[unknown, unknown]>;
    let mapEntriesVisited = 0;
    mapPrototype[Symbol.iterator] = function* (this: Map<unknown, unknown>) {
      const iterator = originalIterator.call(this);
      for (const entry of iterator) {
        mapEntriesVisited += 1;
        yield entry;
      }
    };
    try {
      for (let index = 0; index < 2_000; index += 1) {
        map = overlayReadonlyMap(map, new Map([[`key-${index}`, index]]));
        record = overlayReadonlyRecord(record, { [`key-${index}`]: index });
        array = overlayReadonlyArray(array, new Map([[index, index]]));
      }
    } finally {
      mapPrototype[Symbol.iterator] = originalIterator;
    }

    expect(map.size).toBe(2_001);
    expect(map.get('stable')).toBe(1);
    expect(map.get('key-1999')).toBe(1_999);
    expect(record.stable).toBe(1);
    expect(record['key-1999']).toBe(1_999);
    expect(array[1_999]).toBe(1_999);
    // Map changes and Array changes each contribute one current-delta entry per generation. A
    // history-rescanning implementation grows quadratically and exceeds this linear allowance.
    expect(mapEntriesVisited).toBeLessThan(4_500);
  });
});
