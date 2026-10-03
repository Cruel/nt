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
    expect(text).toContain('no extra keys');
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
    const tree: z.ZodType = z.lazy(() => z.object({ children: z.array(tree) }));
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
});
