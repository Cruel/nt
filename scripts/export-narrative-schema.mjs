// Run inside the upstream checkout using its pinned Zod/tsx installation.
// Translate supported Zod refinements to native-interpretable data, failing closed on new ones.
import { z } from 'zod';
import { recordDefinition, recordSchema, knowledgeValues, relationshipValues } from './src/schema.ts';
import { readCatalog } from './src/catalog.ts';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

async function main() {
  const source = readFileSync('src/schema.ts', 'utf8');
  const schema = z.toJSONSchema(recordDefinition, {
    unrepresentable: 'throw', io: 'input',
    override({ zodSchema, jsonSchema }) {
      for (const check of zodSchema._zod.def.checks ?? []) {
        const def = check._zod.def;
        if (def.check === 'overwrite') {
          if (def.tx.toString().replace(/\s/g, '') !== '(input)=>input.trim()') throw new Error('Unsupported normalization');
          jsonSchema['x-trim'] = true;
        } else if (def.check === 'custom') {
          const fn = def.fn?.toString();
          if (fn === 'values=>new Set(values).size===values.length') jsonSchema['x-unique'] = true;
          else if (['values=>new Set(values.map(d=>d.id)).size===values.length', 'items=>new Set(items.map(i=>i.id)).size===items.length', 'uniqueVariantIds=>new Set(uniqueVariantIds.map(v=>v.id)).size===uniqueVariantIds.length', 'values=>new Set(values.map(value=>value.id)).size===values.length'].includes(fn)) jsonSchema['x-uniqueBy'] = 'id';
          else if (fn === 'v=>new Set(v).size===v.length&&!v.includes("undecided")') {
            jsonSchema['x-unique'] = true; jsonSchema['x-excludedItems'] = ['undecided'];
          } else if (fn === 'd=>d.origin!=="user"||d.authority==="user-protected"') {
            jsonSchema['x-implies'] = {when: {field:'origin', value:'user'}, then: {field:'authority', value:'user-protected'}};
          } else if (fn === 'value=>Object.keys(value).length>0') {
            jsonSchema['x-minProperties'] = 1;
          } else if (fn === 'value=>value.min===void 0||value.min<=value.max') {
            jsonSchema['x-range'] = ['min', 'max'];
          } else if (fn === 'value=>value.min_minutes<=value.max_minutes') {
            jsonSchema['x-range'] = ['min_minutes', 'max_minutes'];
          } else if (fn === 'value=>value.difference!==void 0||value.duration_minutes!==void 0') {
            jsonSchema['x-anyFields'] = ['difference', 'duration_minutes'];
          } else if (!fn && Object.hasOwn(jsonSchema.properties ?? {}, 'first_playthrough') &&
                     Object.hasOwn(jsonSchema.properties ?? {}, 'illustration_concepts')) {
            // The upstream planning superRefine has no serializable function in Zod.
            // Its source is pinned below; native checks are deliberately explicit.
            jsonSchema['x-planningRules'] = true;
            jsonSchema['x-minProperties'] = 1;
          } else throw new Error(`Unsupported upstream refinement: ${fn}`);
        } else if (!['min_length', 'max_length', 'length_equals', 'string_format', 'greater_than', 'number_format'].includes(def.check)) {
          throw new Error(`Unsupported upstream check: ${def.check}`);
        }
      }
    },
  });
  // Ask the authoritative superRefine about each relationship array, rather than
  // maintaining a second table of complete/partial requirements in C++.
  const catalog = await readCatalog('fixtures/reference-story');
  schema['x-stateDomains'] = { knowledge: knowledgeValues, relationship: relationshipValues };
  // Milestone route alternatives are validated against the same record's fulfillment.
  const milestone = schema.oneOf.find(s => s.properties.type.const === 'milestone');
  milestone['x-routeFulfillment'] = true;
  for (const record of catalog.records) {
    const m = record.metadata;
    const variant = schema.oneOf.find(s => s.properties.type.const === m.type);
    function visit(value, node, path) {
      if (Array.isArray(value)) {
        for (let length = 0; length <= value.length; ++length) {
          const candidate = structuredClone(m);
          candidate.completeness = 'complete';
          let owner = candidate;
          for (const key of path.slice(0,-1)) owner = owner[key];
          owner[path.at(-1)] = value.slice(0,length);
          const result = recordSchema.safeParse(candidate);
          const errors = result.success ? [] : result.error.issues.filter(i => JSON.stringify(i.path) === JSON.stringify(path));
          if (errors.some(i => i.code === 'custom' && !i.message.startsWith('Complete ')))
            throw new Error(`Unsupported record refinement at ${path.join('.')}`);
          if (errors.some(i => i.code === 'custom')) continue;
          if (length > (node.minItems ?? 0)) node['x-completeMinItems'] = length;
          break;
        }
        value.forEach((item, i) => visit(item, node.items, [...path,i]));
      } else if (value && typeof value === 'object') {
        if (node.oneOf) node = node.oneOf.find(s => Object.entries(s.properties).some(([key,v]) => 'const' in v && value[key] === v.const));
        for (const [key, item] of Object.entries(value)) visit(item, node.properties[key], [...path,key]);
      }
    }
    visit(m, variant, []);
  }
  // The root superRefine cannot be serialized by Zod. Fail if its implementation
  // changes until the exporter and conformance cases are reviewed together.
  const rootRefinement = source.slice(source.indexOf('export const recordSchema ='));
  const digest = createHash('sha256').update(rootRefinement).digest('hex');
  if (digest !== '2ce411aeedd52e20e6738feb5411bd4e89c8d6757bcee08df5da2fae4513d341') throw new Error(`Root refinement changed (${digest}); review native export and conformance before updating the pin.`);
  const planningRefinement = source.slice(source.indexOf('}).superRefine((value, ctx) => {'), source.indexOf('const milestoneDuration ='));
  const planningDigest = createHash('sha256').update(planningRefinement).digest('hex');
  if (planningDigest !== '6ac130eb9d18f951e2e9b0333fe23ab4288eb91b00b066d9bfd01e9379df0a3f') throw new Error(`Planning refinement changed (${planningDigest}); review native rules before updating the pin.`);
  const keywords = new Set(['$schema', 'oneOf', 'type', 'properties', 'required',
    'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'minimum', 'maximum', 'enum', 'const',
    'pattern', 'x-trim', 'x-unique', 'x-uniqueBy', 'x-excludedItems', 'x-implies',
    'x-completeMinItems', 'x-stateDomains', 'x-minProperties', 'x-range', 'x-anyFields',
    'x-planningRules', 'x-routeFulfillment']);
  function supported(node) {
    for (const key of Object.keys(node))
      if (!keywords.has(key)) throw new Error(`Native schema interpreter does not support ${key}`);
    if (node.type && !['object', 'array', 'string', 'boolean', 'number', 'integer'].includes(node.type))
      throw new Error(`Native schema interpreter does not support type ${node.type}`);
    if (node.minLength && (node.minLength !== 1 || !node['x-trim']))
      throw new Error('Review new string length semantics before exporting');
    if (node.type === 'object' && node.additionalProperties !== false)
      throw new Error('Only strict objects are supported');
    for (const child of Object.values(node.properties ?? {})) supported(child);
    for (const child of node.oneOf ?? []) supported(child);
    if (node.items) supported(node.items);
  }
  supported(schema);
  console.log(JSON.stringify(schema));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
