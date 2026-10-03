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
    const localization = website.documents.find((document) => document.id === 'localization')!;
    const localizationDocumentation = schemaDocumentationEntries(localization.model).flatMap(
      (entry) => [
        ...(entry.documentation.constraints ?? []),
        ...(entry.documentation.examples ?? []).map((example) => example.title),
      ],
    );
    expect(localizationDocumentation).toContain(
      "Every plural pattern must contain an 'other' case.",
    );
    expect(localizationDocumentation).toContain(
      "Every select pattern must contain an 'other' fallback case.",
    );
    expect(localizationDocumentation).toContain('Plural with nested select fallback');
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

    for (const text of [rooms, interactables]) {
      expect(text).toContain(
        'Room Features are concrete gameplay identities: defaultProperties must be empty and Property values belong in localProperties.',
      );
      expect(text).toContain(
        'Interactable-definition Features are reusable configuration: localProperties must be empty and Property defaults belong in defaultProperties.',
      );
    }

    const localization = files['localization.md']!;
    expect(localization).toContain("Every plural pattern must contain an 'other' case.");
    expect(localization).toContain("Every select pattern must contain an 'other' fallback case.");
    expect(localization).toContain('### Plural with nested select fallback');
    expect(localization).toContain('MessageId =');
    expect(localization).toContain('MessageArgumentName =');
    expect(localization).toContain('MessageSelectorArgumentName =');
    expect(localization).toContain('LocalizationWorkflowFingerprint =');
    expect(localization).toContain('LocalizationSourceTrackingFingerprint =');
    expect(localization.match(/format uuid/g) ?? []).toHaveLength(1);
    expect(localization.match(/pattern "\^fnv1a:\[0-9a-f\]\{32\}\$"/g) ?? []).toHaveLength(2);
    expect(localization.match(/pattern "\^\[A-Za-z_\]\[A-Za-z0-9_-\]\*\$"/g) ?? []).toHaveLength(2);

    const archetypes = files['records/archetypes.md']!;
    expect(archetypes).toContain('Each overrides key is a JSON Pointer');
    expect(archetypes).toContain('Character /data/initialWorldState');
    expect(archetypes).toContain('### Override inherited Room configuration');

    const scenes = files['records/scenes.md']!;
    expect(scenes).toContain(
      'Scene Event completionDependencies may name only earlier enabled non-comment Events.',
    );
    expect(scenes).toContain('gameplay-effect-batch operations use GameplayCommand shape');
    expect(scenes).toContain('Choice option effects use GameplayCommand shape');

    const dialogues = files['records/dialogues.md']!;
    expect(dialogues).toContain('offset counts Unicode code points');
    expect(dialogues).toContain('Positioned Dialogue cues currently require an inline text source');
    expect(dialogues).toContain('Sequence blocks admit at most one outgoing next edge');

    const verbs = files['records/verbs.md']!;
    expect(verbs).toContain('qualified-pattern selectors require exactly one wildcard');
    expect(verbs).toContain('bindingOrder must contain every declared Verb slot exactly once');
    expect(verbs).toContain('{slot-id}');

    const interactions = files['records/interactions.md']!;
    expect(interactions).toContain('structurally most-specific matching Rule tier');
    expect(interactions).toContain('ambiguity error');

    const layouts = files['records/layouts.md']!;
    expect(layouts).toContain(
      "sourceMode 'file' owns the companion records/layouts/<layout-id>/layout.rml",
    );
    expect(layouts).toContain('records/layouts/<layout-id>/layout.lua');
    expect(layouts).toContain(
      'Layout input defaultValue must match the declared type and nullability.',
    );
    expect(layouts).toContain('Every State Shape defaultValue must recursively match');

    const project = files['project.md']!;
    expect(project).toContain('worldRasterPolicy: "capped" | "native"');
    expect(project).toContain('width: integer >= 1');
    expect(project).toContain(
      'inclusive range [minimum, maximum] must contain the default scale 1',
    );

    const assets = files['records/assets.md']!;
    expect(assets).toContain('Image Assets require a non-null imageMetadata object.');
    expect(assets).toContain('Every non-image Asset requires imageMetadata to be null.');

    const characters = files['records/characters.md']!;
    expect(characters).toContain(
      'must contain at least one presentation Profile and at least one Expression',
    );
    expect(characters).toContain(
      'presentation Profile must contain at least one layer and at least one pose',
    );

    const materials = files['records/materials.md']!;
    expect(materials).toContain('custom shader override must set at least one');
    expect(materials).toContain('parameter override must set at least one');
    expect(materials).toContain('texture override must set at least one');

    const variables = files['records/variables.md']!;
    expect(variables).toContain('value must match the declared type and nullability.');
    expect(variables).toContain('Enum Variables require at least one non-empty enumValues entry');
    expect(variables).toContain(
      'Non-null values must equal one declared entry; null is permitted when nullable is true.',
    );

    const maps = files['records/maps.md']!;
    expect(maps).toContain('two-exit Map Connection must reference reciprocal Room Exits');
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
