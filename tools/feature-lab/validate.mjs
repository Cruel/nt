import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FEATURE_LAB_MANIFEST_RELATIVE_PATH = 'assets/data/feature-lab.json';
const VALID_STATUSES = new Set(['ready', 'provisional', 'blocked']);
const VALID_VERIFICATION = new Set(['semantic', 'ui', 'visual', 'audio', 'manual']);
const VALID_AUTOMATION_KINDS = new Set(['semantic-test', 'ui-test', 'visual-checkpoint']);
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MANIFEST_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function error(code, path, message) {
  return { code, path, message };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireText(value, pathName, errors) {
  if (typeof value !== 'string' || value.trim() === '')
    errors.push(error('required-text', pathName, 'Expected a non-empty string.'));
}

function validateTimestamp(value, pathName, errors) {
  const milliseconds = typeof value === 'string' && UTC_TIMESTAMP.test(value) ? Date.parse(value) : NaN;
  // Date.parse normalizes impossible dates; a canonical round trip must preserve the input.
  const canonical = typeof value === 'string' && !value.includes('.') ? value.replace('Z', '.000Z') : value;
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== canonical)
    errors.push(error('invalid-timestamp', pathName, 'Expected a valid UTC calendar date in ISO-8601 format ending in Z.'));
}

function requireArray(value, pathName, errors) {
  if (Array.isArray(value)) return value;
  errors.push(error('invalid-collection', pathName, 'Expected an array.'));
  return [];
}

function requireObject(value, pathName, errors) {
  if (isObject(value)) return true;
  errors.push(error('invalid-entry', pathName, 'Expected an object.'));
  return false;
}

function validateUniqueIds(items, pathName, errors) {
  const seen = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const id = items[index]?.id;
    requireText(id, `${pathName}/${index}/id`, errors);
    if (typeof id !== 'string' || id === '') continue;
    if (!MANIFEST_ID.test(id))
      errors.push(
        error(
          'invalid-id',
          `${pathName}/${index}/id`,
          `ID '${id}' must use lowercase kebab-case.`,
        ),
      );
    if (seen.has(id)) errors.push(error('duplicate-id', `${pathName}/${index}/id`, `Duplicate ID '${id}'.`));
    seen.add(id);
  }
}

function withoutModified(value) {
  if (!isObject(value)) return value;
  const copy = structuredClone(value);
  delete copy.modified;
  return copy;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
    .join(',')}}`;
}

function compareTimestampHistory(current, previous, pathName, errors) {
  if (!previous) return;
  if (current.created !== previous.created)
    errors.push(error('created-changed', `${pathName}/created`, 'created is immutable for an existing manifest entry.'));
  if (stable(withoutModified(current)) !== stable(withoutModified(previous)) && current.modified === previous.modified)
    errors.push(error('stale-modified', `${pathName}/modified`, 'Meaningful manifest content changed without updating modified.'));
}

async function fileExists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

export async function validateFeatureLabManifest(catalog, options = {}) {
  const errors = [];
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : null;
  const previousManifest = options.previousManifest;
  if (!isObject(catalog)) return { errors: [error('invalid-root', '/', 'Manifest must be a JSON object.')], derived: { scenarios: {} } };
  if (catalog.schema !== 'noveltea.feature-lab.catalog')
    errors.push(error('invalid-schema', '/schema', "Expected schema 'noveltea.feature-lab.catalog'."));
  if (Object.hasOwn(catalog, 'schemaVersion'))
    errors.push(error('unsupported-field', '/schemaVersion', 'The catalog inherits Project Workspace Format and has no independent schemaVersion.'));

  const categories = requireArray(catalog.categories, '/categories', errors);
  const launches = requireArray(catalog.launches, '/launches', errors);
  const requirements = requireArray(catalog.assetRequirements, '/assetRequirements', errors);
  const visualCheckpoints = requireArray(catalog.visualCheckpoints, '/visualCheckpoints', errors);
  const scenarios = requireArray(catalog.scenarios, '/scenarios', errors);

  validateUniqueIds(categories, '/categories', errors);
  validateUniqueIds(launches, '/launches', errors);
  validateUniqueIds(requirements, '/assetRequirements', errors);
  validateUniqueIds(visualCheckpoints, '/visualCheckpoints', errors);
  validateUniqueIds(scenarios, '/scenarios', errors);
  const categoryIds = new Set(categories.map((entry) => entry?.id));
  const launchIds = new Set(launches.map((entry) => entry?.id));
  const requirementIds = new Set(requirements.map((entry) => entry?.id));
  const visualCheckpointIds = new Set(visualCheckpoints.map((entry) => entry?.id));

  categories.forEach((category, index) => {
    if (!requireObject(category, `/categories/${index}`, errors)) return;
    requireText(category.title, `/categories/${index}/title`, errors);
  });

  for (let index = 0; index < launches.length; index += 1) {
    const launch = launches[index];
    if (!requireObject(launch, `/launches/${index}`, errors)) continue;
    requireText(launch.roomId, `/launches/${index}/roomId`, errors);
    if (projectRoot && typeof launch.roomId === 'string') {
      const roomFile = path.join(projectRoot, 'records', 'rooms', `${launch.roomId}.json`);
      if (!(await fileExists(roomFile)))
        errors.push(error('missing-launch-target', `/launches/${index}/roomId`, `Launch '${launch.id}' references missing Room '${launch.roomId}'.`));
    }
  }

  for (let index = 0; index < visualCheckpoints.length; index += 1) {
    requireObject(visualCheckpoints[index], `/visualCheckpoints/${index}`, errors);
  }

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    if (!requireObject(requirement, `/assetRequirements/${index}`, errors)) continue;
    requireText(requirement.purpose, `/assetRequirements/${index}/purpose`, errors);
    if (!['synthetic', 'curated'].includes(requirement.source))
      errors.push(error('invalid-asset-source', `/assetRequirements/${index}/source`, "Asset requirement source must be 'synthetic' or 'curated'."));
    const realizations = requireArray(requirement.realizations, `/assetRequirements/${index}/realizations`, errors);
    for (let realizationIndex = 0; realizationIndex < realizations.length; realizationIndex += 1) {
      const realization = realizations[realizationIndex];
      if (!requireObject(realization, `/assetRequirements/${index}/realizations/${realizationIndex}`, errors)) continue;
      requireText(realization.assetId, `/assetRequirements/${index}/realizations/${realizationIndex}/assetId`, errors);
      if (!['placeholder', 'reference'].includes(realization.quality))
        errors.push(error('invalid-realization-quality', `/assetRequirements/${index}/realizations/${realizationIndex}/quality`, "Realization quality must be 'placeholder' or 'reference'."));
      if (projectRoot && typeof realization.assetId === 'string') {
        const assetFile = path.join(projectRoot, 'records', 'assets', `${realization.assetId}.json`);
        if (!(await fileExists(assetFile)))
          errors.push(error('missing-asset-realization', `/assetRequirements/${index}/realizations/${realizationIndex}/assetId`, `Missing Asset record '${realization.assetId}'.`));
      }
    }
  }

  const previousScenarios = new Map((previousManifest?.scenarios ?? []).map((entry) => [entry.id, entry]));
  const derived = { scenarios: {} };
  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
    const scenario = scenarios[scenarioIndex];
    const base = `/scenarios/${scenarioIndex}`;
    if (!requireObject(scenario, base, errors)) continue;
    requireText(scenario.title, `${base}/title`, errors);
    requireText(scenario.description, `${base}/description`, errors);
    validateTimestamp(scenario.created, `${base}/created`, errors);
    validateTimestamp(scenario.modified, `${base}/modified`, errors);
    if (
      UTC_TIMESTAMP.test(scenario.created ?? '') &&
      UTC_TIMESTAMP.test(scenario.modified ?? '') &&
      Date.parse(scenario.modified) < Date.parse(scenario.created)
    )
      errors.push(
        error('invalid-timestamp-order', `${base}/modified`, 'modified cannot precede created.'),
      );
    if (!categoryIds.has(scenario.categoryId))
      errors.push(error('missing-category', `${base}/categoryId`, `Unknown category '${scenario.categoryId}'.`));
    if (!VALID_STATUSES.has(scenario.status))
      errors.push(error('invalid-status', `${base}/status`, `Unknown status '${scenario.status}'.`));
    if (!launchIds.has(scenario.launch?.entry))
      errors.push(error('missing-launch', `${base}/launch/entry`, `Unknown launch entry '${scenario.launch?.entry}'.`));
    if (scenario.launch?.setup !== undefined && !launchIds.has(scenario.launch.setup))
      errors.push(error('missing-setup', `${base}/launch/setup`, `Unknown launch setup '${scenario.launch.setup}'.`));

    const checks = requireArray(scenario.checks, `${base}/checks`, errors);
    validateUniqueIds(checks, `${base}/checks`, errors);
    const previous = previousScenarios.get(scenario.id);
    const previousChecks = new Map((previous?.checks ?? []).map((entry) => [entry.id, entry]));
    const ownCurrent = { ...scenario, checks: [] };
    const ownPrevious = previous ? { ...previous, checks: [] } : undefined;
    compareTimestampHistory(ownCurrent, ownPrevious, base, errors);

    const effectiveDates = [scenario.modified];
    const assetRequirements = [];
    for (let checkIndex = 0; checkIndex < checks.length; checkIndex += 1) {
      const check = checks[checkIndex];
      const checkBase = `${base}/checks/${checkIndex}`;
      if (!requireObject(check, checkBase, errors)) continue;
      requireText(check.title, `${checkBase}/title`, errors);
      requireText(check.action, `${checkBase}/action`, errors);
      requireText(check.expected, `${checkBase}/expected`, errors);
      validateTimestamp(check.created, `${checkBase}/created`, errors);
      validateTimestamp(check.modified, `${checkBase}/modified`, errors);
      if (
        UTC_TIMESTAMP.test(check.created ?? '') &&
        UTC_TIMESTAMP.test(check.modified ?? '') &&
        Date.parse(check.modified) < Date.parse(check.created)
      )
        errors.push(
          error(
            'invalid-timestamp-order',
            `${checkBase}/modified`,
            'modified cannot precede created.',
          ),
        );
      if (!VALID_STATUSES.has(check.status))
        errors.push(error('invalid-status', `${checkBase}/status`, `Unknown status '${check.status}'.`));
      if (!VALID_VERIFICATION.has(check.verification))
        errors.push(error('invalid-verification', `${checkBase}/verification`, `Unknown verification mode '${check.verification}'.`));
      effectiveDates.push(check.modified);
      compareTimestampHistory(check, previousChecks.get(check.id), checkBase, errors);

      const refs = requireArray(check.assetRequirements, `${checkBase}/assetRequirements`, errors);
      for (const requirementId of refs) {
        if (!requirementIds.has(requirementId))
          errors.push(error('missing-asset-requirement', `${checkBase}/assetRequirements`, `Unknown asset requirement '${requirementId}'.`));
        if (!assetRequirements.includes(requirementId)) assetRequirements.push(requirementId);
      }
      const automation = requireArray(check.automation, `${checkBase}/automation`, errors);
      for (let automationIndex = 0; automationIndex < automation.length; automationIndex += 1) {
        const target = automation[automationIndex];
        const targetPath = `${checkBase}/automation/${automationIndex}`;
        if (!requireObject(target, targetPath, errors)) continue;
        if (!VALID_AUTOMATION_KINDS.has(target.kind)) {
          errors.push(error('invalid-automation-kind', `${targetPath}/kind`, `Unknown automation kind '${target.kind}'.`));
          continue;
        }
        requireText(target.id, `${targetPath}/id`, errors);
        if (target.kind === 'visual-checkpoint') {
          if (!visualCheckpointIds.has(target.id))
            errors.push(
              error(
                'missing-automation-target',
                `${targetPath}/id`,
                `Unknown visual checkpoint '${target.id}'.`,
              ),
            );
          continue;
        }
        const filename = projectRoot ? path.join(projectRoot, 'records', 'tests', `${target.id}.json`) : null;
        if (filename && !(await fileExists(filename)))
          errors.push(error('missing-automation-target', `${targetPath}/id`, `Missing authored Test '${target.id}'.`));
      }
    }

    const validEffectiveDates = effectiveDates.filter(
      (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)),
    );
    derived.scenarios[scenario.id] = {
      effectiveModified:
        validEffectiveDates.reduce((latest, value) =>
          latest === null || Date.parse(value) > Date.parse(latest) ? value : latest,
        null) ?? null,
      assetRequirements,
    };
  }
  return { errors, derived };
}

async function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--project');
  const projectRoot = path.resolve(
    rootIndex >= 0 ? args[rootIndex + 1] : 'tests/projects/feature-lab',
  );
  const previousIndex = args.indexOf('--previous');
  const previousPath = previousIndex >= 0 ? path.resolve(args[previousIndex + 1]) : null;
  const manifestPath = path.join(projectRoot, FEATURE_LAB_MANIFEST_RELATIVE_PATH);
  const catalog = JSON.parse(await readFile(manifestPath, 'utf8'));
  const previousManifest = previousPath ? JSON.parse(await readFile(previousPath, 'utf8')) : undefined;
  const result = await validateFeatureLabManifest(catalog, { projectRoot, previousManifest });
  if (result.errors.length > 0) {
    for (const item of result.errors) process.stderr.write(`${item.code} ${item.path}: ${item.message}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Feature Lab manifest valid: ${catalog.scenarios.length} scenario(s), ${catalog.scenarios.reduce((sum, scenario) => sum + scenario.checks.length, 0)} check(s).\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
