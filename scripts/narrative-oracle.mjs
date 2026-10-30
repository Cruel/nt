// Executed by the pinned upstream tsx toolchain, with its repository as cwd.
import { createHash } from 'node:crypto';
import { readCatalog } from './src/catalog.ts';
import { parse, stringify } from 'yaml';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function main() {
  const base = await readCatalog('fixtures/reference-story');
  const byId = new Map(base.records.map(r => [r.metadata.id, r.path]));
  const events = base.records.filter(r => r.metadata.type === 'event');
  const first = events.find(r => !r.metadata.prerequisites.any_of[0].completed.length);
  const puzzle = base.records.find(r => r.metadata.type === 'puzzle');
  const solution = puzzle.metadata.solutions[0];
  const milestone = base.records.find(r => r.metadata.type === 'milestone');
  const choice = base.records.find(r => r.metadata.type === 'choice-point');
  const character = base.records.find(r => r.metadata.type === 'character');
  const fact = base.records.find(r => r.metadata.type === 'fact');
  const position = base.records.find(r => r.metadata.type === 'narrative-position');
  const cases = [];
  async function scenario(name, mutate, fixture = 'reference-story') {
    const root = await mkdtemp(join(tmpdir(), 'nt-narrative-oracle-'));
    const patches = {};
    try {
      await cp(`fixtures/${fixture}`, root, { recursive: true });
      const put = async (path, source) => { patches[path] = source; await writeFile(join(root, path), source); };
      const edit = async (id, change) => {
        const path = byId.get(id);
        const source = await readFile(join(root, path), 'utf8');
        const match = /^---\r?\n([\s\S]*?)^---[^\S\r\n]*(?:\r?\n|$)/m.exec(source);
        const m = parse(match[1]);
        change(m);
        await put(path, `---\n${stringify(m)}---\n${source.slice(match[0].length)}`);
      };
      await mutate({ root, edit, put });
      const report = await readCatalog(root);
      const diagnostics = report.diagnostics.map(({code, path, line, column}) => ({code, path, line, column}));
      const coverage = report.coverage;
      // Witness ordering and wording are intentionally not API parity requirements.
      const project = value => Array.isArray(value) ? value.map(project) : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).filter(([k]) => !['keys', 'pointer', 'action', 'witness', 'branches'].includes(k)).map(([k,v]) => [k,project(v)])) : value;
      const sorted = v => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
      const hash = v => createHash('sha256').update(JSON.stringify(sorted(v))).digest('hex');
      cases.push({ name, fixture, patches, expected: {diagnostics,
        recordsHash: hash(report.records), coverageHash: hash(project(coverage))} });
    } finally { await rm(root, {recursive: true, force: true}); }
  }
  await scenario('canonical', async () => {});
  for (const stage of ['01-foundation', '02-architecture', '03-events', '04-composition'])
    await scenario(stage, async () => {}, `planning-stages/${stage}`);
  await scenario('duplicate-id', async ({root, put}) => put('duplicate.md', await readFile(join(root, byId.get(fact.metadata.id)), 'utf8')));
  await scenario('missing-reference', ({edit}) => edit(first.metadata.id, m => m.participants.push('character.absent')));
  await scenario('mistyped-reference', ({edit}) => edit(first.metadata.id, m => m.participants.push('event.absent')));
  await scenario('duplicate-reference', ({edit}) => edit(puzzle.metadata.id, m => m.solutions.push(m.solutions[0])));
  await scenario('schema-number', ({edit}) => edit(first.metadata.id, m => m.schema = 0.1));
  await scenario('schema-other', ({edit}) => edit(first.metadata.id, m => m.schema = '0.2'));
  await scenario('status', ({edit}) => edit(first.metadata.id, m => m.status = 'published'));
  await scenario('unknown-key', ({edit}) => edit(first.metadata.id, m => m.unrecognized = true));
  await scenario('blank-text', ({edit}) => edit(first.metadata.id, m => m.title = ' \t '));
  await scenario('empty-body', async ({root, put}) => {
    const path = byId.get(first.metadata.id); const text = await readFile(join(root,path),'utf8');
    await put(path, text.slice(0, text.indexOf('\n---', 4) + 5));
  });
  await scenario('chronology-cycle', ({edit}) => edit(first.metadata.id, m => m.after.push(m.id)));
  await scenario('required-puzzle-cycle', ({edit}) => edit(solution, m => m.prerequisites.any_of = [{completed:[m.id],not_completed:[]} ]));
  await scenario('contradictory-completion', ({edit}) => edit(solution, m => m.prerequisites.any_of = [{completed:[first.metadata.id],not_completed:[first.metadata.id]}]));
  await scenario('optional-predecessor-not-required', ({edit}) => edit(first.metadata.id, m => m.prerequisites.any_of.push({completed:[solution],not_completed:[]})));
  await scenario('unknown-prerequisite', ({edit}) => edit(first.metadata.id, m => { for (const route of m.prerequisites.any_of) route.unverified = 'Requires editorial review'; }));
  await scenario('impossible-fulfillment', ({edit}) => edit(milestone.metadata.id, m => m.fulfillment.any_of.push(events.slice(-2).map(e => e.metadata.id))));
  const predicate = {kind:'truth',fact:fact.metadata.id,value:true};
  await scenario('contradictory-state', ({edit}) => edit(first.metadata.id, m => m.prerequisites.any_of[0].conditions = [predicate,{...predicate,value:false}]));
  await scenario('impossible-branch', ({edit}) => edit(first.metadata.id, m => m.steps.push({id:'unreachable',branches:[{id:'only',conditions:[{...predicate,value:!fact.metadata.initial}],effects:[]}]})));
  await scenario('unknown-branch', ({edit}) => edit(first.metadata.id, m => m.steps.push({id:'unknown',branches:[{id:'only',conditions:[],effects:[],unverified:'Unmodeled intent'}]})));
  await scenario('bad-outcome', ({edit}) => edit(first.metadata.id, m => m.steps.push({id:'bad',branches:[{id:'only',conditions:[],effects:[{kind:'outcome',choice_point:choice.metadata.id,value:'absent'}]}]})));
  await scenario('duplicate-steps', ({edit}) => edit(first.metadata.id, m => m.steps = [{id:'same',branches:[]},{id:'same',branches:[]} ]));
  await scenario('duplicate-decisions', ({edit}) => edit(first.metadata.id, m => m.decisions = [{id:'same',statement:'one',origin:'agent',authority:'delegated'},{id:'same',statement:'two',origin:'agent',authority:'delegated'}]));
  await scenario('user-decision-authority', ({edit}) => edit(first.metadata.id, m => m.decisions = [{id:'user',statement:'Required intent',origin:'user',authority:'delegated'}]));
  await scenario('invalid-position', ({edit}) => edit(position.metadata.id, m => {m.at='step';m.step='absent';}));
  await scenario('duplicate-initial-knowledge', ({edit}) => edit(character.metadata.id, m => m.initial_knowledge = [{fact:fact.metadata.id,value:'knows'},{fact:fact.metadata.id,value:'unknown'}]));
  await scenario('partial-missing-routes', ({edit}) => edit(first.metadata.id, m => {m.completeness='partial';m.prerequisites.any_of=[];m.steps=[{id:'unfinished',branches:[]}];}));
  await scenario('partial-unknown-effects', ({edit}) => edit(first.metadata.id, m => {m.completeness='partial';m.steps=[];}));
  await scenario('partial-impossible-puzzle', ({edit}) => edit(solution, m => {m.completeness='partial';m.prerequisites.any_of=[{completed:[m.id],not_completed:[]}];}));
  await scenario('partial-empty-puzzle', ({edit}) => edit(puzzle.metadata.id, m => {m.completeness='partial';m.clues=[];m.solutions=[];}));
  await scenario('complete-empty-puzzle', ({edit}) => edit(puzzle.metadata.id, m => {m.clues=[];m.solutions=[];}));
  await scenario('partial-empty-choice', ({edit}) => edit(choice.metadata.id, m => {m.completeness='partial';m.outcomes=[];}));
  await scenario('anchors-and-explicit-tags', async ({root,put}) => {
    const path=byId.get(fact.metadata.id), text=await readFile(join(root,path),'utf8');
    await put(path,text.replace(/^title: (.+)$/m,'title: &unused $1').replace(/^initial: (.+)$/m,'initial: !!bool $1'));
  });
  console.log(JSON.stringify(cases));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
