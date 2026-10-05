import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FEATURE_LAB_MANIFEST_RELATIVE_PATH,
  validateFeatureLabManifest,
} from '../../tools/feature-lab/validate.mjs';

const root = process.cwd();
const projectRoot = path.join(root, 'tests', 'projects', 'feature-lab');
const manifestPath = path.join(projectRoot, FEATURE_LAB_MANIFEST_RELATIVE_PATH);

async function manifest() {
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}

test('canonical Feature Lab manifest satisfies the project-specific contract', async () => {
  const catalog = await manifest();
  const result = await validateFeatureLabManifest(catalog, { projectRoot });
  assert.deepEqual(result.errors, []);
  assert.equal(catalog.schema, 'noveltea.feature-lab.catalog');
  assert.equal(Object.hasOwn(catalog, 'schemaVersion'), false);
  assert.equal(
    catalog.scenarios.some((scenario) => scenario.id === 'rooms-interactions'),
    true,
  );
  assert.equal(
    catalog.scenarios.every((scenario) => !scenario.checks[0]?.action.startsWith('Launch the scenario')),
    true,
  );
});

test('Feature Lab HUD preserves world input and presents active Dialogue text', async () => {
  const layoutRoot = path.join(projectRoot, 'records', 'layouts', 'feature-lab-hud');
  const [rml, rcss, lua, workshop, gateLever] = await Promise.all([
    readFile(path.join(layoutRoot, 'layout.rml'), 'utf8'),
    readFile(path.join(layoutRoot, 'layout.rcss'), 'utf8'),
    readFile(path.join(layoutRoot, 'layout.lua'), 'utf8'),
    readFile(path.join(projectRoot, 'records', 'rooms', 'rooms-interactions-workshop.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'records', 'interactables', 'gate-lever.json'), 'utf8').then(JSON.parse),
  ]);

  assert.match(rml, /<nt-active-text\s+id="rt_body"/u);
  assert.match(rml, /id="feature-lab-scenario-guide"/u);
  assert.match(rml, /id="feature-lab-restart"[^>]*feature_lab\.restart_current/u);
  assert.doesNotMatch(rml, /feature-lab-(?:use-lever|east-gate)/u);
  assert.match(rcss, /#feature-lab-toolbar\s*\{[^}]*pointer-events:\s*none;/u);
  assert.match(rcss, /#feature-lab-text-panel\s*\{[^}]*pointer-events:\s*none;/u);
  assert.match(rcss, /\.feature-lab-scenario\s*\{[^}]*width:\s*46%;/u);
  assert.match(rcss, /\.feature-lab-check-instruction\s*\{[^}]*font-size:\s*17px;/u);
  assert.match(lua, /feature_lab\.render_scenario_guide/u);
  assert.match(lua, /<section class="feature-lab-category"><h2>/u);
  assert.match(lua, /<button class="feature-lab-scenario"[^>]*feature_lab\.launch/u);
  assert.doesNotMatch(lua, /feature-lab-category-label/u);
  assert.match(lua, /feature_lab\.restart_current/u);
  assert.match(lua, /feature-lab-check-number/u);
  assert.match(lua, /check\.guideSubtext/u);
  assert.doesNotMatch(lua, /escape\(check\.expected\).*feature-lab-check-subtext/u);
  assert.doesNotMatch(lua, /Launch fresh/u);
  assert.doesNotMatch(rcss, /border:\s*2px\s+solid\b/u);

  assert.deepEqual(workshop.data.description.source, {
    kind: 'inline',
    text: 'The bedroom door is locked. Press the wall button, then try the door again.',
  });
  assert.equal(workshop.data.hotspots.some((hotspot) => hotspot.id === 'gate-lever-hotspot'), false);
  const doorHotspot = workshop.data.hotspots.find((hotspot) => hotspot.id === 'east-gate-control-hotspot');
  assert.deepEqual(doorHotspot?.target, { kind: 'exit', exitId: 'east-gate' });
  assert.equal(gateLever.data.presentation.hotspots.kind, 'sprite-alpha');
  assert.deepEqual(gateLever.data.presentation.hotspots.hotspot.target, { kind: 'owner' });
});

test('validator rejects duplicate IDs, broken references, invalid statuses, and non-UTC timestamps', async () => {
  const catalog = await manifest();
  const broken = structuredClone(catalog);
  broken.categories.push({ ...broken.categories[0] });
  broken.launches[0].id = 'Invalid ID';
  broken.scenarios[0].categoryId = 'missing-category';
  broken.scenarios[0].status = 'unknown';
  broken.scenarios[0].created = '2026-09-14T12:00:00-05:00';
  broken.scenarios[0].checks[0].created = '2026-09-15T02:00:00Z';
  broken.scenarios[0].checks[0].modified = '2026-09-15T01:00:00Z';
  broken.scenarios[0].checks[0].assetRequirements = ['missing-requirement'];
  broken.scenarios[0].checks[0].automation = [{ kind: 'semantic-test', id: 'missing-test' }];

  const result = await validateFeatureLabManifest(broken, { projectRoot });
  const codes = new Set(result.errors.map((error) => error.code));
  assert(codes.has('duplicate-id'));
  assert(codes.has('invalid-id'));
  assert(codes.has('missing-category'));
  assert(codes.has('invalid-status'));
  assert(codes.has('invalid-timestamp'));
  assert(codes.has('invalid-timestamp-order'));
  assert(codes.has('missing-asset-requirement'));
  assert(codes.has('missing-automation-target'));
});

test('certification requires explicit reasons and separate non-playable classifications', async () => {
  const catalog = await manifest();
  delete catalog.automationOnly;
  delete catalog.deferredCoverage;
  const check = catalog.scenarios[0].checks[0];
  check.status = 'blocked';
  delete check.statusReason;
  const result = await validateFeatureLabManifest(catalog);
  assert(result.errors.some((item) => item.path === '/automationOnly'));
  assert(result.errors.some((item) => item.path === '/deferredCoverage'));
  assert(result.errors.some((item) => item.path.endsWith('/statusReason')));
  const overlapping = await manifest();
  overlapping.automationOnly.push(overlapping.deferredCoverage[0]);
  const overlap = await validateFeatureLabManifest(overlapping);
  assert(overlap.errors.some((item) => item.code === 'conflicting-accounting'));
});

test('realizations and automation resolve record identities and existing source bytes', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'feature-lab-contract-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  for (const collection of ['rooms', 'assets', 'tests'])
    await mkdir(path.join(temporaryRoot, 'records', collection), { recursive: true });
  await writeFile(path.join(temporaryRoot, 'records/rooms/workshop.json'), JSON.stringify({ id: 'workshop', data: { kind: 'room' } }));
  await writeFile(path.join(temporaryRoot, 'records/assets/image.json'), JSON.stringify({ id: 'wrong-image', data: { kind: 'audio', source: { type: 'project-file', path: 'missing.png' } } }));
  await writeFile(path.join(temporaryRoot, 'records/tests/flow.json'), JSON.stringify({ id: 'wrong-flow', data: { kind: 'room' } }));
  const catalog = await manifest();
  catalog.launches = [{ id: 'workshop', roomId: 'workshop' }];
  catalog.assetRequirements = [{ id: 'picture', purpose: 'Landmark', source: 'curated', properties: { kind: 'image' }, realizations: [{ assetId: 'image', quality: 'reference' }] }];
  catalog.scenarios = [catalog.scenarios[0]];
  catalog.scenarios[0].launch = { entry: 'workshop' };
  catalog.scenarios[0].checks = [catalog.scenarios[0].checks[0]];
  catalog.scenarios[0].checks[0].assetRequirements = ['picture'];
  catalog.scenarios[0].checks[0].automation = [{ kind: 'semantic-test', id: 'flow' }];
  const result = await validateFeatureLabManifest(catalog, { projectRoot: temporaryRoot });
  const codes = new Set(result.errors.map((item) => item.code));
  assert(codes.has('record-identity-mismatch'));
  assert(codes.has('record-kind-mismatch'));
  assert(codes.has('missing-asset-source'));
  await mkdir(path.join(temporaryRoot, 'missing.png'));
  const directorySource = await validateFeatureLabManifest(catalog, { projectRoot: temporaryRoot });
  assert(directorySource.errors.some((item) => item.code === 'missing-asset-source'));
});

test('catalog inherits Project versioning and rejects an independent epoch', async () => {
  const catalog = await manifest();
  catalog.schemaVersion = 1;
  const result = await validateFeatureLabManifest(catalog, { projectRoot });
  assert(result.errors.some((error) => error.path === '/schemaVersion'));
});

test('validator rejects impossible calendar dates instead of normalizing them', async () => {
  const catalog = await manifest();
  for (const timestamp of ['2026-02-30T00:00:00Z', '2025-02-29T00:00:00.123Z', '2026-04-31T00:00:00Z', '2026-09-15T24:00:00Z']) {
    const broken = structuredClone(catalog);
    broken.scenarios[0].checks[0].created = timestamp;
    const result = await validateFeatureLabManifest(broken);
    assert(result.errors.some((error) => error.code === 'invalid-timestamp'), timestamp);
  }
  for (const timestamp of ['2024-02-29T00:00:00Z', '2000-02-29T12:34:56.123Z']) {
    const valid = structuredClone(catalog);
    valid.scenarios[0].checks[0].created = timestamp;
    assert.deepEqual((await validateFeatureLabManifest(valid)).errors, []);
  }
});

test('validator rejects malformed reference collections and entries', async () => {
  const catalog = await manifest();
  for (const change of [
    (value) => { value.scenarios[0].checks[0].automation = { kind: 'semantic-test', id: 'missing' }; },
    (value) => { value.scenarios[0].checks[0].assetRequirements = 'missing'; },
    (value) => { value.assetRequirements[0].realizations = {}; },
    (value) => { value.scenarios[0].checks[0].automation = [null]; },
    (value) => { value.assetRequirements[0].realizations = [null]; },
    (value) => { value.scenarios[0].checks = [null]; },
    (value) => { value.scenarios = [null]; },
    (value) => { value.categories = [null]; },
    (value) => { value.launches = [null]; },
    (value) => { value.assetRequirements = [null]; },
    (value) => { value.visualCheckpoints = {}; },
    (value) => { value.visualCheckpoints = [null]; },
  ]) {
    const broken = structuredClone(catalog);
    change(broken);
    const result = await validateFeatureLabManifest(broken, { projectRoot });
    assert(result.errors.length > 0);
  }
});

test('validator resolves declared visual checkpoint references', async () => {
  const catalog = await manifest();
  catalog.visualCheckpoints.push({ id: 'pilot-composition' });
  catalog.scenarios[0].checks[0].automation = [
    { kind: 'visual-checkpoint', id: 'pilot-composition' },
  ];
  let result = await validateFeatureLabManifest(catalog, { projectRoot });
  assert.deepEqual(result.errors, []);

  catalog.scenarios[0].checks[0].automation[0].id = 'missing';
  result = await validateFeatureLabManifest(catalog, { projectRoot });
  assert(result.errors.some((error) => error.code === 'missing-automation-target'));
});

test('timestamp history requires immutable created and meaningful modified changes', async () => {
  const catalog = await manifest();
  const changedWithoutTouch = structuredClone(catalog);
  changedWithoutTouch.scenarios[0].checks[0].expected += ' Changed behavior.';

  let result = await validateFeatureLabManifest(changedWithoutTouch, {
    projectRoot,
    previousManifest: catalog,
  });
  assert(result.errors.some((error) => error.code === 'stale-modified'));

  const changedCreated = structuredClone(catalog);
  changedCreated.scenarios[0].checks[0].created = '2026-09-14T20:00:00Z';
  result = await validateFeatureLabManifest(changedCreated, {
    projectRoot,
    previousManifest: catalog,
  });
  assert(result.errors.some((error) => error.code === 'created-changed'));
});

test('generated accounting separates availability, automation links, exclusions and deferral', async () => {
  const { generateFeatureLabAccounting } = await import('../../tools/feature-lab/report.mjs');
  const catalog = await manifest();
  const scenario = catalog.scenarios.find((entry) => entry.id === 'rooms-interactions');
  scenario.checks = [scenario.checks[0], scenario.checks.find((entry) => entry.id === 'fade-transition')];
  catalog.scenarios = [scenario];
  const result = await generateFeatureLabAccounting(catalog, { projectRoot });
  assert.equal(result.summary.scenarios, 1);
  assert.equal(result.summary.checks, 2);
  assert.equal(result.summary.checksWithAutomation, 1);
  assert.equal(result.checks[1].automation.length, 0);
  assert.equal(result.deferredCoverage[0].id, 'maps');
  assert.equal(result.automationOnly.some((entry) => entry.id === 'maps'), false);
  const witness = result.tests.find((entry) => entry.id === 'rooms-interactions-flow');
  assert.deepEqual(witness.checks, ['rooms-interactions/initial-world-state']);
  const unlinked = result.tests.find((entry) => entry.id === 'runtime-diagnostics-handoff-ui');
  assert.deepEqual(unlinked.checks, []);
  assert(unlinked.steps > 0);
  assert.equal(Object.hasOwn(result.summary, 'passed'), false);
});

test('timestamp history rejects regressions and cosmetic-only timestamp churn', async () => {
  const previousManifest = await manifest();
  const catalog = structuredClone(previousManifest);
  const check = catalog.scenarios[0].checks[0];
  check.expected += ' Changed behavior.';
  check.modified = '2026-10-04T23:21:51Z';
  let result = await validateFeatureLabManifest(catalog, { previousManifest });
  assert(result.errors.some((item) => item.code === 'modified-regressed'));
  check.expected = previousManifest.scenarios[0].checks[0].expected;
  check.modified = '2026-10-05T02:03:54Z';
  result = await validateFeatureLabManifest(catalog, { previousManifest });
  assert(result.errors.some((item) => item.code === 'unnecessary-modified'));
});

test('scenario effective modification and asset requirements are derived from child checks', async () => {
  const catalog = await manifest();
  const scenario = catalog.scenarios[0];
  const result = await validateFeatureLabManifest(catalog, { projectRoot });
  const derived = result.derived.scenarios[scenario.id];
  const newest = [scenario.modified, ...scenario.checks.map((check) => check.modified)].reduce(
    (latest, value) => (Date.parse(value) > Date.parse(latest) ? value : latest),
  );
  assert.equal(derived.effectiveModified, newest);
  assert.deepEqual(
    derived.assetRequirements,
    [...new Set(scenario.checks.flatMap((check) => check.assetRequirements ?? []))],
  );
});
