// Run inside the upstream checkout using its pinned Zod/tsx installation.
// Translate supported Zod refinements to native-interpretable data, failing closed on new ones.
import { z } from 'zod';
import { recordDefinition, recordSchema, knowledgeValues, relationshipValues } from './src/schema.ts';
import { readCatalog } from './src/catalog.ts';

async function main() {
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
          else if (['values=>new Set(values.map(d=>d.id)).size===values.length', 'items=>new Set(items.map(i=>i.id)).size===items.length'].includes(fn)) jsonSchema['x-uniqueBy'] = 'id';
          else if (fn === 'v=>new Set(v).size===v.length&&!v.includes("undecided")') {
            jsonSchema['x-unique'] = true; jsonSchema['x-excludedItems'] = ['undecided'];
          } else if (fn === 'd=>d.origin!=="user"||d.authority==="user-protected"') {
            jsonSchema['x-implies'] = {when: {field:'origin', value:'user'}, then: {field:'authority', value:'user-protected'}};
          } else throw new Error(`Unsupported upstream refinement: ${fn}`);
        } else if (!['min_length', 'max_length', 'length_equals', 'string_format'].includes(def.check)) {
          throw new Error(`Unsupported upstream check: ${def.check}`);
        }
      }
    },
  });
  // Ask the authoritative superRefine about each relationship array, rather than
  // maintaining a second table of complete/partial requirements in C++.
  const catalog = await readCatalog('fixtures/reference-story');
  schema['x-stateDomains'] = { knowledge: knowledgeValues, relationship: relationshipValues };
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
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const source = readFileSync('src/schema.ts', 'utf8');
  const rootRefinement = source.slice(source.indexOf('export const recordSchema ='));
  const digest = createHash('sha256').update(rootRefinement).digest('hex');
  if (digest !== '75c388cb5db00d85537637e898ce03590373204aa546472c38dfa7ac31b8a79e') throw new Error(`Root refinement changed (${digest}); review native export and conformance before updating the pin.`);
  const keywords = new Set(['$schema', 'oneOf', 'type', 'properties', 'required',
    'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'enum', 'const',
    'pattern', 'x-trim', 'x-unique', 'x-uniqueBy', 'x-excludedItems', 'x-implies',
    'x-completeMinItems', 'x-stateDomains']);
  function supported(node) {
    for (const key of Object.keys(node))
      if (!keywords.has(key)) throw new Error(`Native schema interpreter does not support ${key}`);
    if (node.type && !['object', 'array', 'string', 'boolean'].includes(node.type))
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
