import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';
import {
  normalizeSchemaReference,
  renderSchemaNotation,
  schemaDocumentationEntries,
} from '../../shared/project-schema/schema-reference-model';
import { withSchemaDocumentation } from '../../shared/project-schema/schema-documentation';
import {
  createNovelTeaCompactReferenceFiles,
  createNovelTeaWebsiteSchemaReference,
  createNovelTeaRawSchemaFiles,
  schemaSources,
} from '../../shared/project-schema/schema-reference';

describe('compact schema reference', () => {
  it('preserves input requirements, defaults and scalar/array constraints', () => {
    const model = normalizeSchemaReference(
      z
        .object({
          quantity: z.number().int().min(1).max(20),
          enabled: z.boolean().default(true),
          alignment: z.enum(['left', 'center', 'right']),
          traits: z.array(z.string().min(1)).max(3).default([]),
          label: z.string().min(2).max(8).optional(),
        })
        .strict(),
      'Instance',
    );
    const text = renderSchemaNotation(model);
    expect(text).toContain('quantity: integer >= 1 <= 20');
    expect(text).toContain('enabled?: boolean = true');
    expect(text).toContain('alignment: "left" | "center" | "right"');
    expect(text).toContain('traits?: (string length >= 1)[] items <= 3 = []');
    expect(text).toContain('label?: string length >= 2 length <= 8');
    expect(text).not.toContain('no extra keys');
  });

  it('keeps intersection precedence and refuses to silently omit new schema keywords', () => {
    const schema = z.intersection(z.union([z.literal('a'), z.literal('b')]), z.string());
    expect(renderSchemaNotation(normalizeSchemaReference(schema, 'Choice'))).toContain(
      '("a" | "b") & string',
    );
    expect(() =>
      normalizeSchemaReference(z.string().meta({ not: { const: 'forbidden' } }), 'Value'),
    ).toThrow(/Unsupported.*not/);
  });

  it('retains constrained record keys, tuples, nullable values and numeric steps', () => {
    const model = normalizeSchemaReference(
      z.object({
        weights: z.record(z.string().regex(/^[a-z]+$/), z.number().gt(0).multipleOf(0.5)),
        point: z.tuple([z.number(), z.number()]),
        choice: z.literal(null),
        caption: z.string().nullable(),
      }),
      'Constraints',
    );
    const text = renderSchemaNotation(model);
    expect(text).toContain('[key: string pattern "^[a-z]+$"]: number > 0 multiple of 0.5');
    expect(text).toContain('point: [number, number] items >= 2 items <= 2');
    expect(text).toContain('choice: null');
    expect(text).toContain('caption: string | null');
    const optionalTuple = normalizeSchemaReference(
      z.tuple([z.number(), z.string().optional()]),
      'Tuple',
    );
    expect(renderSchemaNotation(optionalTuple)).toContain('items >= 1 items <= 2');
  });

  it('publishes surprising quantity semantics and checked examples for agents and the website', () => {
    const files = createNovelTeaCompactReferenceFiles();
    const website = createNovelTeaWebsiteSchemaReference();
    expect(website.documents.map((document) => document.rawSchemaPath)).toEqual(
      Object.keys(schemaSources),
    );
    expect(Object.keys(createNovelTeaRawSchemaFiles())).toEqual(Object.keys(schemaSources));
    const semantics =
      'When false, aggregate creation of quantity N creates N distinct quantity-one Instances rather than rejecting the creation.';
    expect(files['records/interactables.md']).toContain(semantics);
    const interactables = website.documents.find(
      (document) => document.id === 'records/interactables',
    )!;
    expect(
      schemaDocumentationEntries(interactables.model).flatMap(
        (entry) => entry.documentation.notes ?? [],
      ),
    ).toContain(semantics);
    expect(files['project.md']).toContain('quantity: integer >= 1');
    expect(files['project.md']).toContain('```json');
    expect(files['project.md']).toContain('"definition": {');
    expect(files['common.md']).toContain(
      'Location is authoritative semantic membership. Room visual occurrences do not change it; Unplaced Instances still exist.',
    );
    expect(files['common.md']).toContain('### In a Room');
    const traits = website.documents.find((document) => document.id === 'traits')!;
    const traitDocumentation = schemaDocumentationEntries(traits.model).flatMap((entry) => [
      ...(entry.documentation.notes ?? []),
      ...(entry.documentation.constraints ?? []),
    ]);
    expect(traitDocumentation).toContain(
      'When multiple attached Traits provide a Default for the same Property ID, those Defaults must agree exactly.',
    );
    expect(traitDocumentation).toContain(
      'Omitting defaultValue leaves a Property requirement. Reusable configuration may leave that requirement unresolved, but a concrete gameplay owner or Interactable Instance must resolve an effective compatible value before publication.',
    );
    expect(createNovelTeaCompactReferenceFiles()).toEqual(files);
  });

  it('retains semantic documentation and validates exact JSON examples against the canonical schema', () => {
    const docs = {
      description: 'A live identity.',
      notes: ['Aggregate creation can produce multiple identities.'],
      constraints: ['Non-stackable Instances have quantity one.'],
      lifecycle: ['Applied at creation.'],
      status: 'Current',
      related: ['Interactable Definition'],
      examples: [
        { title: 'One Instance', value: { quantity: 1 }, source: 'fixtures/instance.json' },
      ],
    };
    const schema = withSchemaDocumentation(
      z.object({ quantity: z.number().int().min(1) }).strict(),
      docs,
    );
    const model = normalizeSchemaReference(schema, 'Instance');
    expect(schemaDocumentationEntries(model)).toEqual([{ path: 'Instance', documentation: docs }]);
    expect(() =>
      normalizeSchemaReference(
        withSchemaDocumentation(schema, {
          examples: [{ title: 'Invalid quantity', value: { quantity: 0 } }],
        }),
        'Instance',
      ),
    ).toThrow(/Invalid quantity/);
    expect(() =>
      normalizeSchemaReference(
        withSchemaDocumentation(z.number(), {
          examples: [{ title: 'Not JSON', value: Infinity }],
        }),
        'Number',
      ),
    ).toThrow(/Not JSON/);
  });

  it('keeps discriminators, shared names and recursive references without flattening', () => {
    const room = z.object({ id: z.string() }).strict().meta({ title: 'RoomRef' });
    const location = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('unplaced') }).strict(),
      z.object({ kind: z.literal('room'), room }).strict(),
    ]);
    const tree: z.ZodType = z
      .lazy(() => z.object({ children: z.array(tree) }))
      .meta({ title: 'Tree' });
    const model = normalizeSchemaReference(z.object({ location, origin: room, tree }), 'Example');
    const text = renderSchemaNotation(model);
    expect(text).toContain('kind: "unplaced"');
    expect(text).toContain('kind: "room"');
    expect(text).toContain('room: RoomRef');
    expect(text).toContain('origin: RoomRef');
    expect(text.match(/RoomRef =/g)).toHaveLength(1);
    expect(text).toContain('children: Tree[]');
    expect(text.length).toBeLessThan(1000);
    expect(normalizeSchemaReference(z.object({ location, origin: room, tree }), 'Example')).toEqual(
      model,
    );
  });

  it('keeps production references compact, shared, and free of generated implementation names', () => {
    const files = createNovelTeaCompactReferenceFiles();
    const rooms = files['records/rooms.md']!;
    const interactables = files['records/interactables.md']!;
    const common = files['common.md']!;
    const generatedName = /(?:^|\n)(?:\$ref\d*|\w+(?:Variant|Value)\d+) =/;

    for (const [path, text] of Object.entries(files)) {
      if (!path.endsWith('.md')) continue;
      expect(text).not.toMatch(generatedName);
      expect(text).not.toContain('(no extra keys)');
      expect(text).not.toContain('Condition = Condition');
      expect(text).not.toContain('GameplayCommand = GameplayCommand');
    }

    expect(rooms).toContain('condition: Condition');
    expect(rooms).toContain('beforeEnter: GameplayCommand[]');
    expect(rooms).not.toContain('\nCondition =');
    expect(rooms).not.toContain('\nGameplayCommand =');
    expect(common).toContain('\nCondition =');
    expect(common).toContain('\nGameplayCommand =');
    expect(common).toContain('\nEntityId = string pattern');
    expect(common).toContain('\nFlowTarget =');
    expect(common).toContain('\nInteractableLocation =');
    expect(common).toContain('\nLayoutPersistableValue =');
    expect(common).toContain(
      'Location is authoritative semantic membership. Room visual occurrences do not change it; Unplaced Instances still exist.',
    );
    expect(common).toContain('### In a Room');
    expect(common).toContain('"collection": "rooms"');
    expect(rooms.match(/\^\[a-z\]\[a-z0-9\]\*/g) ?? []).toHaveLength(0);

    const definitionLocations = new Map<string, string[]>();
    const sharedDefinitions = new Set(
      [...common.matchAll(/^([A-Za-z_$][A-Za-z0-9_$]*) = /gm)].map((match) => match[1]!),
    );
    for (const [path, text] of Object.entries(files)) {
      if (!path.endsWith('.md') || path === 'common.md' || path === 'index.md') continue;
      for (const match of text.matchAll(/^([A-Za-z_$][A-Za-z0-9_$]*) = /gm)) {
        const name = match[1]!;
        definitionLocations.set(name, [...(definitionLocations.get(name) ?? []), path]);
      }

      const notation = [...text.matchAll(/```text\n([\s\S]*?)```/g)]
        .map((match) => match[1]!)
        .join('\n');
      const localDefinitions = new Set(
        [...notation.matchAll(/^([A-Za-z_$][A-Za-z0-9_$]*) = /gm)].map((match) => match[1]!),
      );
      const unquotedNotation = notation.replace(/"(?:\\.|[^"\\])*"/g, '');
      const referencedTypes = new Set(
        [...unquotedNotation.matchAll(/\b[A-Z][A-Za-z0-9_$]*\b/g)].map((match) => match[0]),
      );
      const unresolved = [...referencedTypes].filter(
        (name) => name !== 'JSON' && !localDefinitions.has(name) && !sharedDefinitions.has(name),
      );
      expect(unresolved, path).toEqual([]);
    }
    expect([...definitionLocations.entries()].filter(([, paths]) => paths.length > 1)).toEqual([]);

    const conditionStart = common.indexOf('\nCondition =');
    const conditionEnd = common.indexOf('\nCursorId =', conditionStart);
    const condition = common.slice(conditionStart, conditionEnd);
    expect(condition).toContain('quantity: integer >= 0 <= 9007199254740991');
    expect(condition).not.toContain('quantity: integer >= -9007199254740991');

    const semantics = interactables.indexOf('## InteractablesRecord.data.stackable');
    const shape = interactables.indexOf('## Shape and constraints');
    expect(semantics).toBeGreaterThanOrEqual(0);
    expect(shape).toBeGreaterThan(semantics);

    const traits = files['traits.md']!;
    expect(traits).toContain(
      'When multiple attached Traits provide a Default for the same Property ID, those Defaults must agree exactly.',
    );
    expect(traits).toContain(
      'a concrete gameplay owner or Interactable Instance must resolve an effective compatible value before publication.',
    );
  });

  it('keeps every generated raw schema internally resolvable and free of synthetic titles', () => {
    const files = createNovelTeaRawSchemaFiles();
    const conditionQuantityMinimums: number[] = [];

    const resolvePointer = (document: unknown, pointer: string): unknown => {
      if (pointer === '#') return document;
      expect(pointer.startsWith('#/')).toBe(true);
      return pointer
        .slice(2)
        .split('/')
        .reduce<unknown>((value, token) => {
          const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
          expect(value).toBeTypeOf('object');
          expect(value).not.toBeNull();
          expect(Object.hasOwn(value as object, key)).toBe(true);
          return (value as Record<string, unknown>)[key];
        }, document);
    };

    for (const [path, text] of Object.entries(files)) {
      const document = JSON.parse(text) as unknown;
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
        if (!value || typeof value !== 'object') return;
        const record = value as Record<string, unknown>;
        if (typeof record.$ref === 'string') resolvePointer(document, record.$ref);
        if (typeof record.title === 'string') {
          expect(record.title, path).not.toMatch(
            /^(?:__schema\d+|\$ref\d+|\w+(?:Variant|Value|Owner|Source|Binding|Ref|Condition|Command)\d+)$/,
          );
          if (record.title === 'Condition') {
            const resolved =
              typeof record.$ref === 'string'
                ? (resolvePointer(document, record.$ref) as Record<string, unknown>)
                : record;
            const variants = Array.isArray(resolved.oneOf) ? resolved.oneOf : [];
            const quantityBranch = variants.find((branch) => {
              if (!branch || typeof branch !== 'object') return false;
              const properties = (branch as Record<string, unknown>).properties;
              if (!properties || typeof properties !== 'object') return false;
              const kind = (properties as Record<string, unknown>).kind;
              return (
                !!kind &&
                typeof kind === 'object' &&
                (kind as Record<string, unknown>).const === 'inventory-quantity-comparison'
              );
            }) as Record<string, unknown> | undefined;
            const quantity = (quantityBranch?.properties as Record<string, unknown> | undefined)
              ?.quantity as Record<string, unknown> | undefined;
            if (typeof quantity?.minimum === 'number')
              conditionQuantityMinimums.push(quantity.minimum);
          }
        }
        Object.values(record).forEach(visit);
      };
      visit(document);
    }
    expect(conditionQuantityMinimums.length).toBeGreaterThan(0);
    expect(new Set(conditionQuantityMinimums)).toEqual(new Set([0]));
  });
});
